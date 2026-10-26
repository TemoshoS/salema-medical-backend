import { Router, Request, Response } from "express";
import CallbackRequest, {
  type CallbackRequestStatus,
} from "../models/CallbackRequest.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = Router();

router.use(authenticateToken);

const allowedStatuses: CallbackRequestStatus[] = [
  "CALLBACK_PENDING",
  "CALLBACK_IN_PROGRESS",
  "CALLBACK_COMPLETED",
  "CALLBACK_CANCELLED",
];

const allowedTransitions: Record<
  CallbackRequestStatus,
  CallbackRequestStatus[]
> = {
  CALLBACK_PENDING: ["CALLBACK_IN_PROGRESS", "CALLBACK_CANCELLED"],
  CALLBACK_IN_PROGRESS: ["CALLBACK_COMPLETED", "CALLBACK_CANCELLED"],
  CALLBACK_COMPLETED: [],
  CALLBACK_CANCELLED: [],
};

/**
 * Submit a callback request for the authenticated patient.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "PATIENT") {
      return res.status(403).json({
        success: false,
        message: "Only patient accounts can request a callback.",
      });
    }

    const { callbackNumber, reason } = req.body as {
      callbackNumber?: unknown;
      reason?: unknown;
    };

    if (
      typeof callbackNumber !== "string" ||
      callbackNumber.trim().length < 7 ||
      callbackNumber.trim().length > 30
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid callback phone number.",
      });
    }

    if (
      typeof reason !== "string" ||
      reason.trim().length < 3 ||
      reason.trim().length > 1000
    ) {
      return res.status(400).json({
        success: false,
        message: "Please describe why you need a callback.",
      });
    }

    const callbackRequest = await CallbackRequest.create({
      userId: req.user.userId,
      callbackNumber: callbackNumber.trim(),
      reason: reason.trim(),
      status: "CALLBACK_PENDING",
    });

    return res.status(201).json({
      success: true,
      message:
        "Your callback request has been received. A callback has not yet been completed or confirmed.",
      callbackRequest: {
        callbackRequestId: callbackRequest.callbackRequestId,
        callbackNumber: callbackRequest.callbackNumber,
        reason: callbackRequest.reason,
        status: callbackRequest.status,
        createdAt: callbackRequest.createdAt,
      },
    });
  } catch (error) {
    console.error("Create callback request failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to submit your callback request.",
    });
  }
});

/**
 * List callback requests for authorised Control Room staff.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    if (!req.user || req.user.role !== "CONTROL_ROOM") {
      return res.status(403).json({
        success: false,
        message: "Only authorised Control Room staff can view callback requests.",
      });
    }

    const callbackRequests = await CallbackRequest.find()
      .select(
        "callbackRequestId userId callbackNumber reason status createdAt updatedAt"
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      success: true,
      count: callbackRequests.length,
      callbackRequests,
    });
  } catch (error) {
    console.error("List callback requests failed:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve callback requests.",
    });
  }
});

/**
 * Update callback progress through the Control Room workflow.
 */
router.patch(
  "/:callbackRequestId/status",
  async (req: Request, res: Response) => {
    try {
      if (!req.user || req.user.role !== "CONTROL_ROOM") {
        return res.status(403).json({
          success: false,
          message: "Only authorised Control Room staff can update callback status.",
        });
      }

      const { status } = req.body as { status?: unknown };

      if (
        typeof status !== "string" ||
        !allowedStatuses.includes(status as CallbackRequestStatus)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid callback request status.",
        });
      }

      const callbackRequest = await CallbackRequest.findOne({
        callbackRequestId: req.params.callbackRequestId,
      });

      if (!callbackRequest) {
        return res.status(404).json({
          success: false,
          message: "Callback request not found.",
        });
      }

      const nextStatus = status as CallbackRequestStatus;

      if (!allowedTransitions[callbackRequest.status].includes(nextStatus)) {
        return res.status(409).json({
          success: false,
          message: `Cannot change callback status from ${callbackRequest.status} to ${nextStatus}.`,
        });
      }

      callbackRequest.status = nextStatus;
      await callbackRequest.save();

      return res.json({
        success: true,
        message: "Callback request status updated.",
        callbackRequest: {
          callbackRequestId: callbackRequest.callbackRequestId,
          status: callbackRequest.status,
          updatedAt: callbackRequest.updatedAt,
        },
      });
    } catch (error) {
      console.error("Update callback request status failed:", error);

      return res.status(500).json({
        success: false,
        message: "Unable to update callback request status.",
      });
    }
  }
);

export default router;
