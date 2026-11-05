
import { Router, Request, Response } from "express";
import MedicalRequest, {
  type MedicalRequestStatus,
} from "../models/MedicalRequest.js";
import User from "../models/User.js";
import ProviderApplication from "../models/ProviderApplication.js";
import ProviderPresence from "../models/ProviderPresence.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { medicalRequestLimiter } from "../middleware/rateLimiters.js";
import {
  broadcastProviderLocation,
  broadcastMedicalRequestStatus,
  broadcastNewMedicalRequest,
  broadcastProviderPresence,
} from "../services/medicalTrackingSocket.js";

const router = Router();

router.use(authenticateToken);


/**
 * List approved and email-verified providers for the control room.
 */
router.get("/providers/approved", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "CONTROL_ROOM") {
      return res.status(403).json({
        success: false,
        message: "Only authorised control-room users can view providers.",
      });
    }

    const approvedApplications = await ProviderApplication.find({
      status: "APPROVED",
    })
      .select("userId providerType organisationName serviceArea")
      .lean();

    const applicationByUserId = new Map(
      approvedApplications.map((application) => [
        application.userId.toString(),
        application,
      ])
    );

    const providers = await User.find({
      _id: {
        $in: approvedApplications.map((application) => application.userId),
      },
      role: "PROVIDER",
      accountStatus: "APPROVED",
      emailVerified: true,
    })
      .select("_id fullName email phoneNumber")
      .sort({ fullName: 1 })
      .lean();

    const eligibleProviders = providers.flatMap((provider) => {
      const application = applicationByUserId.get(provider._id.toString());
      if (!application) return [];

      return [{
        id: provider._id.toString(),
        fullName: provider.fullName,
        email: provider.email,
        phoneNumber: provider.phoneNumber,
        providerType: application.providerType,
        organisationName: application.organisationName,
        serviceArea: application.serviceArea,
      }];
    });

    return res.json({
      success: true,
      count: eligibleProviders.length,
      providers: eligibleProviders,
    });
  } catch (error) {
    console.error("List approved providers failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve approved providers.",
    });
  }
});



/**
 * Provider heartbeat: only approved providers may publish their own GPS.
 * The Control Room receives this feed; patients do not.
 */
router.patch("/providers/presence", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "PROVIDER") {
      return res.status(403).json({
        success: false,
        message: "Only provider accounts can publish provider presence.",
      });
    }

    const providerId = req.user.userId;
    const [user, application] = await Promise.all([
      User.findOne({
        _id: providerId,
        role: "PROVIDER",
        accountStatus: "APPROVED",
        emailVerified: true,
      }).select("_id"),
      ProviderApplication.findOne({
        userId: providerId,
        status: "APPROVED",
      }).select("_id"),
    ]);

    if (!user || !application) {
      return res.status(403).json({
        success: false,
        message: "An approved provider application is required.",
      });
    }

    const latitude = req.body?.latitude;
    const longitude = req.body?.longitude;

    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required.",
      });
    }

    const presence = await ProviderPresence.findOneAndUpdate(
      { userId: providerId },
      { $set: { latitude, longitude, updatedAt: new Date() } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const payload = {
      providerId,
      latitude: presence.latitude,
      longitude: presence.longitude,
      updatedAt: presence.updatedAt,
    };

    broadcastProviderPresence(payload);

    return res.json({ success: true, presence: payload });
  } catch (error) {
    console.error("Update provider presence failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to update provider presence.",
    });
  }
});

/**
 * Fleet feed for authenticated Control Room users.
 * A location is online only when its last update is recent.
 */
router.get("/providers/presence", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "CONTROL_ROOM") {
      return res.status(403).json({
        success: false,
        message: "Only authorised Control Room users can view fleet locations.",
      });
    }

    const applications = await ProviderApplication.find({ status: "APPROVED" })
      .select("userId providerType organisationName serviceArea vehicleType vehicleRegistrationNumber")
      .lean();

    const applicationByUserId = new Map(
      applications.map((application) => [application.userId.toString(), application])
    );

    const users = await User.find({
      _id: { $in: applications.map((application) => application.userId) },
      role: "PROVIDER",
      accountStatus: "APPROVED",
      emailVerified: true,
    }).select("_id fullName").lean();

    const userIds = users.map((user) => user._id.toString());
    const presences = await ProviderPresence.find({
      userId: { $in: userIds },
    }).lean();

    const presenceByUserId = new Map(
      presences.map((presence) => [presence.userId, presence])
    );

    const activeStatuses = [
      "PROVIDER_ACCEPTED",
      "DISPATCHED",
      "ON_THE_WAY",
      "ARRIVED_AT_PICKUP",
      "PATIENT_TRANSPORTING",
    ];

    const activeRequestFilter: Record<string, unknown> = {
      assignedProviderId: { $in: userIds },
      status: { $in: activeStatuses },
    };

    const activeRequests = await MedicalRequest.find(
      activeRequestFilter as any
    )
      .select("assignedProviderId requestId status")
      .lean()
      .exec() as Array<{
        assignedProviderId?: string;
        requestId: string;
        status: string;
      }>;

    const activeRequestByProvider = new Map<string, { requestId?: string; status?: string }>();
    for (const request of activeRequests) {
      if (request.assignedProviderId) {
        activeRequestByProvider.set(String(request.assignedProviderId), {
          requestId: request.requestId,
          status: request.status,
        });
      }
    }

    const onlineCutoff = Date.now() - 90_000;

    const fleet = users.map((user) => {
      const id = user._id.toString();
      const application = applicationByUserId.get(id);
      const presence = presenceByUserId.get(id);
      const updatedAt = presence?.updatedAt ?? null;
      const online = Boolean(
        presence &&
        updatedAt &&
        new Date(updatedAt).getTime() >= onlineCutoff
      );
      const assignment = activeRequestByProvider.get(id);

      return {
        providerId: id,
        fullName: user.fullName,
        providerType: application?.providerType,
        organisationName: application?.organisationName,
        serviceArea: application?.serviceArea,
        vehicleType: application?.vehicleType,
        vehicleRegistrationNumber: application?.vehicleRegistrationNumber,
        latitude: presence?.latitude ?? null,
        longitude: presence?.longitude ?? null,
        updatedAt,
        online,
        assigned: Boolean(assignment),
        available: online && !assignment,
        activeRequestId: assignment?.requestId ?? null,
        activeRequestStatus: assignment?.status ?? null,
      };
    });

    return res.json({ success: true, count: fleet.length, providers: fleet });
  } catch (error) {
    console.error("List provider presence failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to retrieve provider presence.",
    });
  }
});

/**
 * List medical requests belonging to the authenticated patient.
 * Patients can only retrieve their own requests.
 */
router.get("/patient/mine", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (req.user.role !== "PATIENT") {
      return res.status(403).json({
        success: false,
        message: "Only patient accounts can view their own requests.",
      });
    }

    const requests = await MedicalRequest.find({
      userId: req.user.userId,
    })
      .select(
        [
          "requestId",
          "serviceType",
          "urgencyLevel",
          "description",
          "callbackNumber",
          "status",
          "pickupAddress",
          "pickupLocation",
          "pickupLocationVerified",
          "destinationAddress",
          "destinationLocation",
          "requestedDateTime",
          "wheelchairRequired",
          "companionTravelling",
          "transportNotes",
          "dispatchConfirmedAt",
          "providerLocation",
          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      success: true,
      count: requests.length,
      requests,
    });
  } catch (error) {
    console.error("List patient medical requests failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve your medical requests.",
    });
  }
});

/**
 * List medical requests for the authorised control room.
 * Returns the 100 most recent requests, newest first.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "CONTROL_ROOM") {
      return res.status(403).json({
        success: false,
        message: "Only authorised control-room users can view all medical requests.",
      });
    }

    const requests = await MedicalRequest.find()
      .select(
        [
          "requestId",
          "userId",
          "callbackNumber",
          "serviceType",
          "urgencyLevel",
          "description",
          "pickupAddress",
          "pickupLocation",
          "destinationAddress",
          "destinationLocation",
          "requestedDateTime",
          "wheelchairRequired",
          "companionTravelling",
          "transportNotes",
          "status",
          "assignedProviderId",
          "dispatchConfirmedAt",
          "providerLocation",
          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      success: true,
      count: requests.length,
      requests,
    });
  } catch (error) {
    console.error("List medical requests failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve medical requests.",
    });
  }
});


// Create a medical request for the authenticated patient.
router.post("/", medicalRequestLimiter, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (req.user.role !== "PATIENT") {
      return res.status(403).json({
        success: false,
        message: "Only patient accounts can submit medical requests.",
      });
    }

    const {
      callbackNumber,
      serviceType,
      description,
      pickupAddress,
      pickupLocation,
      destinationAddress,
      destinationLocation,
      requestedDateTime,
      wheelchairRequired,
      companionTravelling,
      transportNotes,
    } = req.body;

    if (
      typeof callbackNumber !== "string" ||
      !callbackNumber.trim() ||
      typeof pickupAddress !== "string" ||
      !pickupAddress.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Callback number and pickup address are required.",
      });
    }

    if (
      serviceType !== "EMERGENCY_AMBULANCE" &&
      serviceType !== "MEDICAL_TRANSPORT"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid medical service type.",
      });
    }

    if (
      serviceType === "MEDICAL_TRANSPORT" &&
      (
        typeof destinationAddress !== "string" ||
        !destinationAddress.trim() ||
        !destinationLocation ||
        !requestedDateTime
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Medical transport requires a selected destination and requested date/time.",
      });
    }

    // Validate transport-only fields on the server as well as in the app.
    if (serviceType === "MEDICAL_TRANSPORT") {
      const appointmentDate = new Date(requestedDateTime);

      if (
        typeof requestedDateTime !== "string" ||
        !requestedDateTime.trim() ||
        !Number.isFinite(appointmentDate.getTime()) ||
        appointmentDate.getTime() <= Date.now()
      ) {
        return res.status(400).json({
          success: false,
          message: "Medical transport date and time must be valid and in the future.",
        });
      }

      if (
        typeof wheelchairRequired !== "boolean" ||
        typeof companionTravelling !== "boolean"
      ) {
        return res.status(400).json({
          success: false,
          message: "Wheelchair and companion selections must be true or false.",
        });
      }

      if (
        transportNotes !== undefined &&
        (typeof transportNotes !== "string" || transportNotes.length > 1000)
      ) {
        return res.status(400).json({
          success: false,
          message: "Transport notes must be text no longer than 1000 characters.",
        });
      }
    }

    // Validate pickup coordinates if supplied.
    if (pickupLocation !== undefined) {
      if (
        !pickupLocation ||
        typeof pickupLocation.latitude !== "number" ||
        typeof pickupLocation.longitude !== "number" ||
        !Number.isFinite(pickupLocation.latitude) ||
        !Number.isFinite(pickupLocation.longitude) ||
        pickupLocation.latitude < -90 ||
        pickupLocation.latitude > 90 ||
        pickupLocation.longitude < -180 ||
        pickupLocation.longitude > 180
      ) {
        return res.status(400).json({
          success: false,
          message: "Pickup location must contain valid latitude and longitude.",
        });
      }
    }

    // Validate destination coordinates when supplied.
    if (destinationLocation !== undefined) {
      if (
        !destinationLocation ||
        typeof destinationLocation.latitude !== "number" ||
        typeof destinationLocation.longitude !== "number" ||
        !Number.isFinite(destinationLocation.latitude) ||
        !Number.isFinite(destinationLocation.longitude) ||
        destinationLocation.latitude < -90 ||
        destinationLocation.latitude > 90 ||
        destinationLocation.longitude < -180 ||
        destinationLocation.longitude > 180
      ) {
        return res.status(400).json({
          success: false,
          message: "Destination location must contain valid latitude and longitude.",
        });
      }
    }

    const request = await MedicalRequest.create({
      userId: req.user.userId,
      callbackNumber: callbackNumber.trim(),
      serviceType,
      urgencyLevel:
        serviceType === "EMERGENCY_AMBULANCE"
          ? "EMERGENCY"
          : "NON_EMERGENCY",
      description,
      pickupAddress: pickupAddress.trim(),
      pickupLocation,
      destinationAddress:
        typeof destinationAddress === "string"
          ? destinationAddress.trim()
          : undefined,
      destinationLocation,
      requestedDateTime,
      wheelchairRequired,
      companionTravelling,
      transportNotes,
      status: "REQUEST_SUBMITTED",
    });

    broadcastNewMedicalRequest(
      request.requestId,
      request.status,
      request.serviceType,
      request.createdAt
    );

    return res.status(201).json({
      success: true,
      message:
        "Medical request submitted. An ambulance or transport provider has not yet been confirmed.",
      request: {
        requestId: request.requestId,
        serviceType: request.serviceType,
        status: request.status,
        createdAt: request.createdAt,
      },
    });
  } catch (error) {
    console.error("Create medical request failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to submit the medical request.",
    });
  }
});

// Update request status through the control-room workflow.
router.patch("/:requestId/status", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "CONTROL_ROOM") {
      return res.status(403).json({
        success: false,
        message: "Only authorised control-room users can update request status.",
      });
    }

    const { status, assignedProviderId, dispatchConfirmed } = req.body as {
      status?: string;
      assignedProviderId?: string;
      dispatchConfirmed?: boolean;
    };

    const allowedStatuses: MedicalRequestStatus[] = [
      "REQUEST_SUBMITTED",
      "CONTROL_ROOM_REVIEWING",
      "PROVIDER_BEING_CONTACTED",
      "PROVIDER_ACCEPTED",
      "DISPATCHED",
      "ON_THE_WAY",
      "ARRIVED_AT_PICKUP",
      "PATIENT_TRANSPORTING",
      "COMPLETED",
      "ASSISTANCE_NOT_CONFIRMED",
      "CANCELLED",
    ];

    if (
      typeof status !== "string" ||
      !allowedStatuses.includes(status as MedicalRequestStatus)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid medical request status.",
      });
    }

    const nextStatus = status as MedicalRequestStatus;

    const request = await MedicalRequest.findOne({
      requestId: req.params.requestId,
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Medical request not found.",
      });
    }

    const allowedTransitions: Record<
      MedicalRequestStatus,
      MedicalRequestStatus[]
    > = {
      REQUEST_SUBMITTED: ["CONTROL_ROOM_REVIEWING", "CANCELLED"],
      CONTROL_ROOM_REVIEWING: [
        "PROVIDER_BEING_CONTACTED",
        "ASSISTANCE_NOT_CONFIRMED",
        "CANCELLED",
      ],
      PROVIDER_BEING_CONTACTED: [
        "PROVIDER_ACCEPTED",
        "ASSISTANCE_NOT_CONFIRMED",
        "CANCELLED",
      ],
      PROVIDER_ACCEPTED: [
        "DISPATCHED",
        "ASSISTANCE_NOT_CONFIRMED",
        "CANCELLED",
      ],
      DISPATCHED: ["ON_THE_WAY"],
      ON_THE_WAY: ["ARRIVED_AT_PICKUP"],
      ARRIVED_AT_PICKUP: ["PATIENT_TRANSPORTING"],
      PATIENT_TRANSPORTING: ["COMPLETED"],
      COMPLETED: [],
      ASSISTANCE_NOT_CONFIRMED: [],
      CANCELLED: [],
    };

    if (!allowedTransitions[request.status].includes(nextStatus)) {
      return res.status(409).json({
        success: false,
        message: `Cannot change request status from ${request.status} to ${nextStatus}.`,
      });
    }

    if (assignedProviderId !== undefined) {
      if (
        nextStatus !== "PROVIDER_BEING_CONTACTED" ||
        typeof assignedProviderId !== "string" ||
        !/^[a-fA-F0-9]{24}$/.test(assignedProviderId)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "A valid provider ID can only be assigned when contacting a provider.",
        });
      }

      const provider = await User.findById(assignedProviderId).select(
        "role accountStatus emailVerified"
      );

      if (
        !provider ||
        provider.role !== "PROVIDER" ||
        provider.accountStatus !== "APPROVED" ||
        provider.emailVerified !== true
      ) {
        return res.status(400).json({
          success: false,
          message: "The provider must have a verified and approved account.",
        });
      }

      const providerApplication = await ProviderApplication.findOne({
        userId: provider._id,
        status: "APPROVED",
      }).select("providerType");

      if (!providerApplication) {
        return res.status(400).json({
          success: false,
          message:
            "The provider must have an approved provider application before assignment.",
        });
      }

      const providerType = providerApplication.providerType;

      if (
        request.serviceType === "EMERGENCY_AMBULANCE" &&
        providerType !== "AMBULANCE_COMPANY"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Emergency ambulance requests can only be assigned to an approved ambulance company.",
        });
      }

      if (
        request.serviceType === "MEDICAL_TRANSPORT" &&
        providerType !== "MEDICAL_TRANSPORT_COMPANY" &&
        providerType !== "INDIVIDUAL_DRIVER"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Medical transport requests can only be assigned to an approved medical transport company or eligible individual driver.",
        });
      }

      if (
        request.serviceType === "MEDICAL_TRANSPORT" &&
        providerType === "INDIVIDUAL_DRIVER" &&
        request.urgencyLevel !== "NON_EMERGENCY"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Individual drivers can only be assigned to non-emergency transport requests.",
        });
      }

      request.assignedProviderId = provider._id.toString();
    }

    if (
      nextStatus === "PROVIDER_ACCEPTED" &&
      !request.assignedProviderId
    ) {
      return res.status(409).json({
        success: false,
        message: "Assign a provider before recording provider acceptance.",
      });
    }

    if (nextStatus === "DISPATCHED") {
      if (dispatchConfirmed !== true) {
        return res.status(400).json({
          success: false,
          message:
            "Explicit dispatch confirmation is required before marking a request as dispatched.",
        });
      }

      if (!request.assignedProviderId) {
        return res.status(409).json({
          success: false,
          message: "A provider must be assigned before dispatch is confirmed.",
        });
      }

      request.dispatchConfirmedAt = new Date();
    } else if (dispatchConfirmed === true) {
      return res.status(400).json({
        success: false,
        message:
          "Dispatch can only be confirmed when changing the status to DISPATCHED.",
      });
    }

    if (
      nextStatus === "CONTROL_ROOM_REVIEWING" &&
      !request.assignedAdminId
    ) {
      request.assignedAdminId = req.user.userId;
    }

    request.status = nextStatus;
    await request.save();
    broadcastMedicalRequestStatus(
      request.requestId,
      request.status,
      request.updatedAt,
      request.dispatchConfirmedAt
    );

    return res.json({
      success: true,
      message: "Medical request status updated.",
      request: {
        requestId: request.requestId,
        serviceType: request.serviceType,
        status: request.status,
        dispatchConfirmedAt: request.dispatchConfirmedAt,
        updatedAt: request.updatedAt,
      },
    });
  } catch (error) {
    console.error("Update medical request status failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update the medical request status.",
    });
  }
});


/**
 * List requests assigned to the authenticated provider.
 */
router.get("/provider/assigned", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "PROVIDER") {
      return res.status(403).json({
        success: false,
        message: "Only provider accounts can view assigned requests.",
      });
    }

    const requests = await MedicalRequest.find({
      assignedProviderId: req.user.userId,
    })
      .select(
        [
          "requestId",
          "callbackNumber",
          "serviceType",
          "urgencyLevel",
          "description",
          "pickupAddress",
          "pickupLocation",
          "destinationAddress",
          "destinationLocation",
          "requestedDateTime",
          "wheelchairRequired",
          "companionTravelling",
          "transportNotes",
          "status",
          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      count: requests.length,
      requests,
    });
  } catch (error) {
    console.error("List provider requests failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve assigned requests.",
    });
  }
});

/**
 * Accept a request assigned to the authenticated provider.
 */
router.patch("/:requestId/accept", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "PROVIDER") {
      return res.status(403).json({
        success: false,
        message: "Only provider accounts can accept requests.",
      });
    }

    const request = await MedicalRequest.findOne({
      requestId: req.params.requestId,
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Medical request not found.",
      });
    }

    if (request.assignedProviderId !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: "You are not assigned to this medical request.",
      });
    }

    if (request.status !== "PROVIDER_BEING_CONTACTED") {
      return res.status(409).json({
        success: false,
        message: `This request cannot be accepted while its status is ${request.status}.`,
      });
    }

    request.status = "PROVIDER_ACCEPTED";
    await request.save();
    broadcastMedicalRequestStatus(
      request.requestId,
      request.status,
      request.updatedAt,
      request.dispatchConfirmedAt
    );

    return res.json({
      success: true,
      message: "Medical request accepted successfully.",
      request: {
        requestId: request.requestId,
        serviceType: request.serviceType,
        status: request.status,
        updatedAt: request.updatedAt,
      },
    });
  } catch (error) {
    console.error("Accept provider request failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to accept the medical request.",
    });
  }
});


/**
 * Update progress for a request assigned to the authenticated provider.
 * Providers can only move their own dispatched requests forward.
 */
router.patch("/:requestId/progress", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "PROVIDER") {
      return res.status(403).json({
        success: false,
        message: "Only provider accounts can update request progress.",
      });
    }

    const { status } = req.body as { status?: string };

    const providerStatuses: MedicalRequestStatus[] = [
      "ON_THE_WAY",
      "ARRIVED_AT_PICKUP",
      "PATIENT_TRANSPORTING",
      "COMPLETED",
    ];

    if (
      typeof status !== "string" ||
      !providerStatuses.includes(status as MedicalRequestStatus)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid provider progress status.",
      });
    }

    const nextStatus = status as MedicalRequestStatus;

    const request = await MedicalRequest.findOne({
      requestId: req.params.requestId,
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Medical request not found.",
      });
    }

    if (request.assignedProviderId !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: "You are not assigned to this medical request.",
      });
    }

    if (!request.dispatchConfirmedAt) {
      return res.status(409).json({
        success: false,
        message: "Progress updates are only allowed after dispatch.",
      });
    }

    const allowedNextStatus: Partial<
      Record<MedicalRequestStatus, MedicalRequestStatus>
    > = {
      DISPATCHED: "ON_THE_WAY",
      ON_THE_WAY: "ARRIVED_AT_PICKUP",
      ARRIVED_AT_PICKUP: "PATIENT_TRANSPORTING",
      PATIENT_TRANSPORTING: "COMPLETED",
    };

    if (allowedNextStatus[request.status] !== nextStatus) {
      return res.status(409).json({
        success: false,
        message: `Cannot change request status from ${request.status} to ${nextStatus}.`,
      });
    }

    request.status = nextStatus;
    await request.save();
    broadcastMedicalRequestStatus(
      request.requestId,
      request.status,
      request.updatedAt,
      request.dispatchConfirmedAt
    );

    return res.json({
      success: true,
      message: "Request progress updated successfully.",
      request: {
        requestId: request.requestId,
        serviceType: request.serviceType,
        status: request.status,
        updatedAt: request.updatedAt,
      },
    });
  } catch (error) {
    console.error("Update provider progress failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update request progress.",
    });
  }
});



// Update GPS for a request assigned to the authenticated provider.
router.patch("/:requestId/location", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "PROVIDER") {
      return res.status(403).json({
        success: false,
        message: "Only provider accounts can update ambulance location.",
      });
    }

    const { latitude, longitude } = req.body as {
      latitude?: number;
      longitude?: number;
    };

    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required.",
      });
    }

    const request = await MedicalRequest.findOne({
      requestId: req.params.requestId,
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Medical request not found.",
      });
    }

    if (request.assignedProviderId !== req.user.userId) {
      return res.status(403).json({
        success: false,
        message: "You are not assigned to this medical request.",
      });
    }

    const trackableStatuses: MedicalRequestStatus[] = [
      "DISPATCHED",
      "ON_THE_WAY",
    ];

    if (
      !request.dispatchConfirmedAt ||
      !trackableStatuses.includes(request.status)
    ) {
      return res.status(409).json({
        success: false,
        message: "Location updates are only allowed after dispatch.",
      });
    }

   const providerLocation = {
  latitude,
  longitude,
  updatedAt: new Date(),
};

request.providerLocation = providerLocation;

await request.save();

broadcastProviderLocation(
  request.requestId,
  request.status,
  providerLocation
);

    return res.json({
      success: true,
      message: "Provider location updated.",
      request: {
        requestId: request.requestId,
        status: request.status,
        providerLocation: request.providerLocation,
      },
    });
  } catch (error) {
    console.error("Update provider location failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update provider location.",
    });
  }
});

// Retrieve a request only if the authenticated user is authorised.
router.get("/:requestId", async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const request = await MedicalRequest.findOne({
      requestId: req.params.requestId,
    }).select(
      "requestId userId serviceType status pickupAddress pickupLocation destinationAddress destinationLocation createdAt updatedAt assignedProviderId dispatchConfirmedAt providerLocation"
    );

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Medical request not found.",
      });
    }

    const isPatientOwner =
      req.user.role === "PATIENT" &&
      request.userId === req.user.userId;

    const isControlRoom = req.user.role === "CONTROL_ROOM";

    const isAssignedProvider =
      req.user.role === "PROVIDER" &&
      request.assignedProviderId === req.user.userId;

    if (!isPatientOwner && !isControlRoom && !isAssignedProvider) {
      return res.status(404).json({
        success: false,
        message: "Medical request not found.",
      });
    }

    return res.json({
      success: true,
      request: {
        requestId: request.requestId,
        serviceType: request.serviceType,
        status: request.status,
        pickupAddress: request.pickupAddress,
        pickupLocation: request.pickupLocation,
        destinationAddress: request.destinationAddress,
        destinationLocation: request.destinationLocation,
        providerLocation: request.providerLocation,
        dispatchConfirmedAt: request.dispatchConfirmedAt,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      },
    });
  } catch (error) {
    console.error("Get medical request failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve the medical request.",
    });
  }
});

export default router;
