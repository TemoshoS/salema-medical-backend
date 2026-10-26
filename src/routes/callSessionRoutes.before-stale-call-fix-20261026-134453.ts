import { Router, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import CallSession, {
  type CallSessionStatus,
  type CallType,
} from "../models/CallSession.js";
import MedicalRequest from "../models/MedicalRequest.js";
import User from "../models/User.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import {
  broadcastIncomingCall,
  broadcastCallToControlRoom,
  getOnlineControlRoomUserIds,
} from "../services/medicalTrackingSocket.js";

const router = Router();

router.use(authenticateToken);

type UserRole = "PATIENT" | "CONTROL_ROOM" | "PROVIDER";

function isUserRole(value: unknown): value is UserRole {
  return (
    value === "PATIENT" ||
    value === "CONTROL_ROOM" ||
    value === "PROVIDER"
  );
}

async function canAccessRequest(
  requestId: string,
  userId: string,
  role: UserRole
) {
  const request = await MedicalRequest.findOne({ requestId }).select(
    "requestId userId assignedProviderId assignedAdminId status"
  );

  if (!request) return null;

  const ownsRequest = role === "PATIENT" && request.userId === userId;
  const isControlRoom = role === "CONTROL_ROOM";
  const isAssignedProvider =
    role === "PROVIDER" && request.assignedProviderId === userId;

  if (!ownsRequest && !isControlRoom && !isAssignedProvider) {
    return null;
  }

  return request;
}

function isParticipant(
  session: {
    callerUserId: string;
    recipientUserId: string;
  },
  userId: string
) {
  return session.callerUserId === userId ||
    session.recipientUserId === userId;
}

/**
 * Create an in-app call invitation for an authorised participant.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    if (!req.user || !isUserRole(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Your account cannot start a call.",
      });
    }

    const { requestId, recipientUserId: requestedRecipientId, callType } =
      req.body as {
        requestId?: unknown;
        recipientUserId?: unknown;
        callType?: unknown;
      };

    const hasRequestId =
      typeof requestId === "string" && requestId.trim().length > 0;

    if (
      (requestId !== undefined &&
        requestId !== null &&
        typeof requestId !== "string") ||
      (typeof requestId === "string" && requestId.trim().length === 0) ||
      (callType !== "VIDEO" && callType !== "AUDIO")
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid call type and request ID are required.",
      });
    }

    const isDirectPatientCall =
      !hasRequestId && req.user.role === "PATIENT";

    let recipientUserId: string;

    if (isDirectPatientCall) {
      const onlineStaffIds = await getOnlineControlRoomUserIds();

      if (onlineStaffIds.length === 0) {
        return res.status(503).json({
          success: false,
          message:
            "No Control Room staff are online right now. Please request a callback instead.",
        });
      }

      // Temporary recipient. The first staff member to accept
      // becomes the actual recipient.
      recipientUserId = onlineStaffIds[0];
    } else {
      if (
        typeof requestedRecipientId !== "string" ||
        !/^[a-fA-F0-9]{24}$/.test(requestedRecipientId)
      ) {
        return res.status(400).json({
          success: false,
          message: "A valid call recipient is required.",
        });
      }

      recipientUserId = requestedRecipientId;
    }

    if (recipientUserId === req.user.userId) {
      return res.status(400).json({
        success: false,
        message: "You cannot call your own account.",
      });
    }

    const recipient = await User.findById(recipientUserId).select(
      "role accountStatus emailVerified fullName"
    );

    if (
      !recipient ||
      recipient.accountStatus !== "APPROVED" ||
      recipient.emailVerified !== true ||
      !isUserRole(recipient.role)
    ) {
      return res.status(404).json({
        success: false,
        message: "The call recipient is unavailable.",
      });
    }

    const callerId = req.user.userId;
    const callerRole = req.user.role;
    const recipientRole = recipient.role;

    let medicalRequest: Awaited<ReturnType<typeof canAccessRequest>> = null;

    if (hasRequestId) {
      medicalRequest = await canAccessRequest(
        (requestId as string).trim(),
        callerId,
        callerRole
      );

      if (!medicalRequest) {
        return res.status(403).json({
          success: false,
          message: "You are not authorised to call about this request.",
        });
      }
    }

    let permitted = false;

    if (!hasRequestId) {
      // Direct calls without a medical request are limited to
      // patient -> approved Control Room.
      permitted =
        callerRole === "PATIENT" && recipientRole === "CONTROL_ROOM";
    } else if (medicalRequest) {
      const patientId = medicalRequest.userId;
      const assignedProviderId = medicalRequest.assignedProviderId;
      const assignedAdminId = medicalRequest.assignedAdminId;

      if (callerRole === "PATIENT") {
        permitted =
          recipientRole === "CONTROL_ROOM" &&
          (!assignedAdminId || assignedAdminId === recipientUserId);
      } else if (callerRole === "CONTROL_ROOM") {
        permitted =
          (recipientRole === "PATIENT" && recipientUserId === patientId) ||
          (recipientRole === "PROVIDER" &&
            Boolean(assignedProviderId) &&
            recipientUserId === assignedProviderId);
      } else if (callerRole === "PROVIDER") {
        permitted =
          assignedProviderId === callerId &&
          ((recipientRole === "PATIENT" && recipientUserId === patientId) ||
            (recipientRole === "CONTROL_ROOM" &&
              (!assignedAdminId || assignedAdminId === recipientUserId)));
      }
    }

    if (!permitted) {
      return res.status(403).json({
        success: false,
        message: hasRequestId
          ? "This recipient is not authorised for this medical request."
          : "Only patients can directly call the Control Room without a medical request.",
      });
    }

    const activeQuery: Record<string, unknown> = {
      status: { $in: ["RINGING", "ACCEPTED"] },
      $or: isDirectPatientCall
        ? [
            { callerUserId: callerId },
            { recipientUserId: callerId },
          ]
        : [
            { callerUserId: callerId },
            { recipientUserId: callerId },
            { callerUserId: recipientUserId },
            { recipientUserId },
          ],
    };

    if (hasRequestId && medicalRequest) {
      activeQuery.requestId = medicalRequest.requestId;
    }

    const activeSession = await CallSession.findOne(activeQuery);

    if (activeSession) {
      return res.status(409).json({
        success: false,
        message: "One of these participants already has an active call.",
      });
    }

    const callSessionId = randomUUID();
    const roomName = `salema-call-${callSessionId}`;

    const session = await CallSession.create({
      callSessionId,
      ...(hasRequestId && medicalRequest
        ? { requestId: medicalRequest.requestId }
        : {}),
      callerUserId: callerId,
      callerRole,
      recipientUserId,
      recipientRole,
      callType: callType as CallType,
      status: "RINGING",
      roomName,
    });

    const callPayload = {
      callSessionId: session.callSessionId,
      ...(session.requestId ? { requestId: session.requestId } : {}),
      callerUserId: session.callerUserId,
      callerRole: session.callerRole,
      recipientUserId: session.recipientUserId,
      recipientRole: session.recipientRole,
      callType: session.callType,
      status: session.status,
      createdAt: session.createdAt,
    };

    if (isDirectPatientCall) {
      broadcastCallToControlRoom("call-session:incoming", callPayload);
    } else {
      broadcastIncomingCall(
        recipientUserId,
        "call-session:incoming",
        callPayload
      );
    }

    return res.status(201).json({
      success: true,
      message: "Call invitation created. The recipient has not accepted yet.",
      callSession: callPayload,
    });
  } catch (error) {
    console.error("Create call invitation failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to create the call invitation.",
    });
  }
});

/**
 * List call invitations involving the authenticated user.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const sessions = await CallSession.find({
      $or: [
        { callerUserId: req.user.userId },
        { recipientUserId: req.user.userId },
      ],
    })
      .select(
        "callSessionId requestId callerUserId callerRole recipientUserId recipientRole callType status createdAt acceptedAt endedAt outcome"
      )
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({
      success: true,
      count: sessions.length,
      callSessions: sessions,
    });
  } catch (error) {
    console.error("List call sessions failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load call sessions.",
    });
  }
});

/**
 * Accept or decline an incoming call invitation.
 */
router.patch("/:callSessionId/respond", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const { response } = req.body as { response?: unknown };

    if (response !== "ACCEPT" && response !== "DECLINE") {
      return res.status(400).json({
        success: false,
        message: "Response must be ACCEPT or DECLINE.",
      });
    }

    let session = await CallSession.findOne({
      callSessionId: req.params.callSessionId,
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Call session not found.",
      });
    }

    const isDirectTeamCall =
      !session.requestId &&
      session.callerRole === "PATIENT" &&
      session.recipientRole === "CONTROL_ROOM";

    if (isDirectTeamCall) {
      if (req.user.role !== "CONTROL_ROOM") {
        return res.status(403).json({
          success: false,
          message: "Only Control Room staff can respond to this call.",
        });
      }

      if (session.status !== "RINGING") {
        return res.status(409).json({
          success: false,
          message: "Another staff member has already handled this call.",
        });
      }

      if (response === "DECLINE") {
        // Decline this invitation locally; leave the team call ringing.
        return res.json({
          success: true,
          localDecline: true,
          callSession: {
            callSessionId: session.callSessionId,
            callType: session.callType,
            status: "RINGING",
          },
        });
      }

      const acceptedAt = new Date();

      // Atomic claim: only one staff member can accept this call.
      const claimedSession = await CallSession.findOneAndUpdate(
        {
          callSessionId: session.callSessionId,
          status: "RINGING",
          requestId: null,
          callerRole: "PATIENT",
          recipientRole: "CONTROL_ROOM",
        },
        {
          $set: {
            recipientUserId: req.user.userId,
            status: "ACCEPTED",
            acceptedAt,
            startedAt: acceptedAt,
          },
        },
        { new: true },
      );

      if (!claimedSession) {
        return res.status(409).json({
          success: false,
          message: "Another staff member has already accepted this call.",
        });
      }

      session = claimedSession;

      broadcastCallToControlRoom("call-session:resolved", {
        callSessionId: session.callSessionId,
        status: "ACCEPTED",
        recipientUserId: req.user.userId,
      });
    } else {
      // Preserve existing request-linked invitation permissions.
      if (session.recipientUserId !== req.user.userId) {
        return res.status(403).json({
          success: false,
          message: "Only the invited recipient can respond to this call.",
        });
      }

      if (session.status !== "RINGING") {
        return res.status(409).json({
          success: false,
          message: "This call invitation is no longer awaiting a response.",
        });
      }

      if (response === "ACCEPT") {
        session.status = "ACCEPTED";
        session.acceptedAt = new Date();
        session.startedAt = session.acceptedAt;
      } else {
        session.status = "DECLINED";
        session.endedAt = new Date();
        session.outcome = "Recipient declined the call.";
      }

      await session.save();
    }

    const responseEvent = {
      callSessionId: session.callSessionId,
      ...(session.requestId ? { requestId: session.requestId } : {}),
      callerUserId: session.callerUserId,
      callerRole: session.callerRole,
      recipientUserId: session.recipientUserId,
      recipientRole: session.recipientRole,
      callType: session.callType,
      status: session.status,
      createdAt: session.createdAt,
      acceptedAt: session.acceptedAt,
      endedAt: session.endedAt,
      outcome: session.outcome,
    };

    broadcastIncomingCall(
      session.callerUserId,
      "call-session:updated",
      responseEvent
    );
    broadcastIncomingCall(
      session.recipientUserId,
      "call-session:updated",
      responseEvent
    );

    return res.json({
      success: true,
      callSession: {
        callSessionId: session.callSessionId,
        requestId: session.requestId,
        callType: session.callType,
        status: session.status,
        acceptedAt: session.acceptedAt ?? null,
        endedAt: session.endedAt ?? null,
      },
    });
  } catch (error) {
    console.error("Respond to call invitation failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to respond to the call invitation.",
    });
  }
});

/**
 * Issue a room-scoped LiveKit token for an accepted call participant.
 */
router.post("/:callSessionId/token", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const session = await CallSession.findOne({
      callSessionId: req.params.callSessionId,
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Call session not found.",
      });
    }

    if (!isParticipant(session, req.user.userId)) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this call.",
      });
    }

    if (session.status !== "ACCEPTED") {
      return res.status(409).json({
        success: false,
        message: "The call must be accepted before joining.",
      });
    }

    const isCaller = session.callerUserId === req.user.userId;
    const expectedRole = isCaller
      ? session.callerRole
      : session.recipientRole;

    if (req.user.role !== expectedRole) {
      return res.status(403).json({
        success: false,
        message: "Your current account role does not match this call.",
      });
    }

    if (session.requestId) {
      const medicalRequest = await canAccessRequest(
        session.requestId,
        req.user.userId,
        req.user.role
      );

      if (!medicalRequest) {
        return res.status(403).json({
          success: false,
          message: "You are no longer authorised to join this call.",
        });
      }
    }

    const livekitUrl = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!livekitUrl || !apiKey || !apiSecret) {
      return res.status(503).json({
        success: false,
        message: "In-app calling is not configured on the server yet.",
      });
    }

    const user = await User.findById(req.user.userId).select("fullName");

    const token = new AccessToken(apiKey, apiSecret, {
      identity: req.user.userId,
      name: user?.fullName ?? "Salema Medical user",
      ttl: "10m",
    });

    token.addGrant({
      roomJoin: true,
      room: session.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomCreate: false,
      roomAdmin: false,
      roomRecord: false,
    });

    const jwt = await token.toJwt();

    return res.json({
      success: true,
      livekitUrl,
      token: jwt,
      callSession: {
        callSessionId: session.callSessionId,
        requestId: session.requestId,
        callType: session.callType,
        status: session.status,
      },
    });
  } catch (error) {
    console.error("Create LiveKit participant token failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to prepare the secure call connection.",
    });
  }
});

/**
 * End an accepted call or cancel an outgoing invitation.
 */
router.patch("/:callSessionId/end", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const session = await CallSession.findOne({
      callSessionId: req.params.callSessionId,
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Call session not found.",
      });
    }

    if (!isParticipant(session, req.user.userId)) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this call.",
      });
    }

    const allowedCurrentStatuses: CallSessionStatus[] = [
      "RINGING",
      "ACCEPTED",
    ];

    if (!allowedCurrentStatuses.includes(session.status)) {
      return res.status(409).json({
        success: false,
        message: "This call session has already ended.",
      });
    }

    if (session.status === "RINGING" &&
        session.callerUserId !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: "Only the caller can cancel an unanswered invitation.",
      });
    }

    session.status =
      session.status === "RINGING" ? "CANCELLED" : "ENDED";
    session.endedAt = new Date();
    session.outcome =
      session.status === "CANCELLED"
        ? "Caller cancelled the invitation."
        : "Call ended by a participant.";

    await session.save();

    const endEvent = {
      callSessionId: session.callSessionId,
      ...(session.requestId ? { requestId: session.requestId } : {}),
      callerUserId: session.callerUserId,
      callerRole: session.callerRole,
      recipientUserId: session.recipientUserId,
      recipientRole: session.recipientRole,
      callType: session.callType,
      status: session.status,
      createdAt: session.createdAt,
      acceptedAt: session.acceptedAt,
      endedAt: session.endedAt,
      outcome: session.outcome,
    };

    broadcastIncomingCall(
      session.callerUserId,
      "call-session:updated",
      endEvent
    );
    broadcastIncomingCall(
      session.recipientUserId,
      "call-session:updated",
      endEvent
    );

    if (
      !session.requestId &&
      session.callerRole === "PATIENT" &&
      session.recipientRole === "CONTROL_ROOM"
    ) {
      broadcastCallToControlRoom("call-session:resolved", {
        callSessionId: session.callSessionId,
        status: session.status,
        recipientUserId: session.recipientUserId,
      });
    }

    return res.json({
      success: true,
      callSession: {
        callSessionId: session.callSessionId,
        status: session.status,
        endedAt: session.endedAt,
        outcome: session.outcome,
      },
    });
  } catch (error) {
    console.error("End call session failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to end the call session.",
    });
  }
});

/**
 * List authorised control-room recipients for a patient's request.
 */
router.get("/recipients", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "PATIENT") {
      return res.status(403).json({
        success: false,
        message: "Only patients can use this recipient lookup.",
      });
    }

    const requestId =
      typeof req.query.requestId === "string"
        ? req.query.requestId.trim()
        : "";

    let medicalRequest: Awaited<ReturnType<typeof canAccessRequest>> = null;

    if (requestId) {
      medicalRequest = await canAccessRequest(
        requestId,
        req.user.userId,
        "PATIENT"
      );

      if (!medicalRequest) {
        return res.status(403).json({
          success: false,
          message: "You are not authorised to access this medical request.",
        });
      }
    }

    const filter: Record<string, unknown> = {
      role: "CONTROL_ROOM",
      accountStatus: "APPROVED",
      emailVerified: true,
    };

    if (medicalRequest?.assignedAdminId) {
      filter._id = medicalRequest.assignedAdminId;
    }

    const users = await User.find(filter)
      .select("_id fullName")
      .sort({ fullName: 1 })
      .lean();

    return res.json({
      success: true,
      recipients: users.map((user) => ({
        id: user._id.toString(),
        fullName: user.fullName,
      })),
    });
  } catch (error) {
    console.error("Load call recipients failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load call recipients.",
    });
  }
});

export default router;
