
import type { Server as HttpServer } from "node:http";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import MedicalRequest from "../models/MedicalRequest.js";
import User from "../models/User.js";

interface AuthenticatedSocket extends Socket {
  data: {
    userId?: string;
    role?: string;
  };
}

let trackingIO: Server | null = null;
const CONTROL_ROOM_ROOM = "control-room:requests";

function getRequestRoom(requestId: string): string {
  return `medical-request:${requestId}`;
}

function getUserRoom(userId: string): string {
  return `user:${userId}`;
}

export function initializeMedicalTrackingSocket(
  httpServer: HttpServer,
  allowedOrigin: string
): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigin,
      methods: ["GET", "POST"],
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (typeof token !== "string" || !token.trim()) {
        return next(new Error("Authentication required."));
      }

      const secret = process.env.JWT_SECRET;

      if (!secret) {
        return next(new Error("Authentication is not configured."));
      }

      const decoded = jwt.verify(token, secret);

      if (
        typeof decoded === "string" ||
        typeof decoded.sub !== "string" ||
        !decoded.sub
      ) {
        return next(new Error("Invalid access token."));
      }

      const payload = decoded as JwtPayload;

      const user = await User.findById(payload.sub).select(
        "role accountStatus emailVerified"
      );

      if (!user || !user.emailVerified) {
        return next(new Error("Account not found or not verified."));
      }

      if (user.accountStatus !== "APPROVED") {
        return next(new Error("Account is not approved."));
      }

      const authenticatedSocket = socket as AuthenticatedSocket;
      authenticatedSocket.data.userId = user.id;
      authenticatedSocket.data.role = user.role;

      return next();
    } catch {
      return next(new Error("Invalid or expired access token."));
    }
  });

  io.on("connection", (socket) => {
    const connectedUserId = (socket as AuthenticatedSocket).data.userId;

    // Private room used for recipient-specific call notifications.
    if (connectedUserId) {
      void socket.join(getUserRoom(connectedUserId));
    }
    const authenticatedSocket = socket as AuthenticatedSocket;

    console.log(
      `Authenticated tracking client connected: ${socket.id} (${authenticatedSocket.data.role})`
    );

    // Only authenticated, approved CONTROL_ROOM accounts join this room.
    if (authenticatedSocket.data.role === "CONTROL_ROOM") {
      void socket.join(CONTROL_ROOM_ROOM);
    }

    socket.on(
      "medical-request:join",
      async (payload: { requestId?: unknown } = {}) => {
        try {
          const requestId = payload?.requestId;

          if (typeof requestId !== "string" || !requestId.trim()) {
            socket.emit("medical-request:error", {
              message: "A valid request ID is required.",
            });
            return;
          }

          const request = await MedicalRequest.findOne({
            requestId: requestId.trim(),
          }).select("requestId userId assignedProviderId status providerLocation");

          if (!request) {
            socket.emit("medical-request:error", {
              message: "Medical request not found.",
            });
            return;
          }

          const userId = authenticatedSocket.data.userId;
          const role = authenticatedSocket.data.role;

          const isPatientOwner =
            role === "PATIENT" && request.userId === userId;

          const isControlRoom = role === "CONTROL_ROOM";

          const isAssignedProvider =
            role === "PROVIDER" &&
            request.assignedProviderId === userId;

          if (
            !isPatientOwner &&
            !isControlRoom &&
            !isAssignedProvider
          ) {
            socket.emit("medical-request:error", {
              message: "You are not authorised to track this request.",
            });
            return;
          }

          await socket.join(getRequestRoom(request.requestId));

          socket.emit("medical-request:tracking-ready", {
            requestId: request.requestId,
            status: request.status,
            providerLocation: request.providerLocation ?? null,
          });
        } catch (error) {
          console.error("Socket request subscription failed:", error);

          socket.emit("medical-request:error", {
            message: "Unable to subscribe to tracking updates.",
          });
        }
      }
    );

    socket.on("disconnect", () => {
      console.log(`Tracking client disconnected: ${socket.id}`);
    });
  });

  trackingIO = io;
  return io;
}

/**
 * Return unique Control Room user IDs with an authenticated,
 * approved account connected to the socket server.
 */
export async function getOnlineControlRoomUserIds(): Promise<string[]> {
  if (!trackingIO) return [];

  const sockets = await trackingIO
    .in(CONTROL_ROOM_ROOM)
    .fetchSockets();

  return [
    ...new Set(
      sockets
        .map((socket) => {
          const data = socket.data as {
            userId?: string;
            role?: string;
          };

          return data.role === "CONTROL_ROOM" ? data.userId : undefined;
        })
        .filter((userId): userId is string => Boolean(userId))
    ),
  ];
}

/**
 * Broadcast a direct patient call to all connected Control Room staff.
 */
export function broadcastCallToControlRoom(
  event: "call-session:incoming" | "call-session:resolved",
  payload: Record<string, unknown>
): void {
  if (!trackingIO) {
    console.error("Tracking socket server has not been initialized.");
    return;
  }

  trackingIO.to(CONTROL_ROOM_ROOM).emit(event, payload);
}

export function broadcastProviderLocation(
  requestId: string,
  status: string,
  providerLocation: {
    latitude: number;
    longitude: number;
    updatedAt: Date;
  }
): void {
  if (!trackingIO) {
    console.error("Tracking socket server has not been initialized.");
    return;
  }

  trackingIO.to(getRequestRoom(requestId)).to(CONTROL_ROOM_ROOM).emit(
    "medical-request:location-updated",
    {
      requestId,
      status,
      providerLocation,
    }
  );
}


/**
 * Broadcast status changes to clients authorised in this request's room.
 */
export function broadcastMedicalRequestStatus(
  requestId: string,
  status: string,
  updatedAt: Date,
  dispatchConfirmedAt?: Date
): void {
  if (!trackingIO) {
    console.error("Tracking socket server has not been initialized.");
    return;
  }

  trackingIO.to(getRequestRoom(requestId)).to(CONTROL_ROOM_ROOM).emit(
    "medical-request:status-updated",
    {
      requestId,
      status,
      updatedAt,
      dispatchConfirmedAt: dispatchConfirmedAt ?? null,
    }
  );
}


/**
 * Notify connected control-room dashboards that a request was created.
 * The dashboard fetches the full request through the existing authenticated API.
 */
export function broadcastNewMedicalRequest(
  requestId: string,
  status: string,
  serviceType: string,
  createdAt: Date
): void {
  if (!trackingIO) {
    console.error("Tracking socket server has not been initialized.");
    return;
  }

  trackingIO.to(CONTROL_ROOM_ROOM).emit("medical-request:created", {
    requestId,
    status,
    serviceType,
    createdAt,
  });
}


/**
 * Send a call-session event only to the intended authenticated user.
 */
export function broadcastIncomingCall(
  recipientUserId: string,
  event:
    | "call-session:incoming"
    | "call-session:updated",
  payload: {
    callSessionId: string;
    requestId?: string;
    callerUserId: string;
    callerRole: string;
    recipientUserId: string;
    recipientRole: string;
    callType: string;
    status: string;
    createdAt?: Date;
    acceptedAt?: Date;
    endedAt?: Date;
    outcome?: string;
  }
): void {
  if (!trackingIO) {
    console.error("Tracking socket server has not been initialized.");
    return;
  }

  trackingIO.to(getUserRoom(recipientUserId)).emit(event, payload);
}
