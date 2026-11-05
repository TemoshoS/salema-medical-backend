import type { Request, Response } from "express";
import mongoose from "mongoose";
import fs from "node:fs/promises";
import path from "node:path";
import ProviderApplication from "../models/ProviderApplication.js";
import User from "../models/User.js";
import { providerDocumentStorageRoot } from "../middleware/providerDocumentUpload.js";

const applicationStatuses = [
  "PENDING_REVIEW",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
] as const;

function isControlRoom(req: Request, res: Response): boolean {
  if (req.user?.role === "CONTROL_ROOM") return true;

  res.status(403).json({
    success: false,
    message: "Only authorised Control Room staff can review provider applications.",
  });
  return false;
}

function validApplicationId(
  applicationId: string,
  res: Response
): boolean {
  if (mongoose.isValidObjectId(applicationId)) return true;

  res.status(400).json({
    success: false,
    message: "Invalid provider application ID.",
  });
  return false;
}

export async function listProviderApplications(
  req: Request,
  res: Response
): Promise<void> {
  if (!isControlRoom(req, res)) return;

  try {
    const status = req.query.status;

    if (
      status !== undefined &&
      (typeof status !== "string" ||
        !applicationStatuses.includes(
          status as (typeof applicationStatuses)[number]
        ))
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid application status filter.",
      });
      return;
    }

    const applications = await ProviderApplication.find(
      typeof status === "string"
        ? { status: status as (typeof applicationStatuses)[number] }
        : {}
    )
      .populate(
        "userId",
        "fullName email phoneNumber emailVerified accountStatus createdAt"
      )
      .populate("reviewedBy", "fullName email")
      .sort({ createdAt: -1 })
      .lean();

    const safeApplications = applications.map((application) => ({
      ...application,
      documents: (application.documents ?? []).map(
        ({ storedName, ...document }) => document
      ),
    }));

    res.status(200).json({
      success: true,
      count: safeApplications.length,
      applications: safeApplications,
    });
  } catch (error) {
    console.error("List provider applications failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load provider applications.",
    });
  }
}

export async function getProviderApplication(
  req: Request,
  res: Response
): Promise<void> {
  if (!isControlRoom(req, res)) return;

  const applicationId = req.params.applicationId;
  if (typeof applicationId !== "string") {
    res.status(400).json({
      success: false,
      message: "Invalid provider application ID.",
    });
    return;
  }
  if (!validApplicationId(applicationId, res)) return;

  try {
    const application = await ProviderApplication.findById(applicationId)
      .select("+identityNumber +documents.storedName")
      .populate(
        "userId",
        "fullName email phoneNumber emailVerified accountStatus createdAt"
      )
      .populate("reviewedBy", "fullName email")
      .lean();

    if (!application) {
      res.status(404).json({
        success: false,
        message: "Provider application not found.",
      });
      return;
    }

    const { documents = [], ...applicationDetails } = application;
    const safeDocuments = documents.map(
      ({ storedName, ...document }) => document
    );

    res.status(200).json({
      success: true,
      application: {
        ...applicationDetails,
        documents: safeDocuments,
      },
    });
  } catch (error) {
    console.error("Get provider application failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load this provider application.",
    });
  }
}


export async function downloadProviderApplicationDocument(
  req: Request,
  res: Response
): Promise<void> {
  if (!isControlRoom(req, res)) return;

  const applicationId = req.params.applicationId;
  const documentId = req.params.documentId;

  if (
    typeof applicationId !== "string" ||
    !validApplicationId(applicationId, res)
  ) return;

  if (
    typeof documentId !== "string" ||
    !mongoose.isValidObjectId(documentId)
  ) {
    res.status(400).json({
      success: false,
      message: "Invalid provider document ID.",
    });
    return;
  }

  try {
    const application = await ProviderApplication.findById(applicationId)
      .select("+documents.storedName")
      .lean();

    if (!application) {
      res.status(404).json({
        success: false,
        message: "Provider application not found.",
      });
      return;
    }

    const document = application.documents?.find(
      (item) => item._id.toString() === documentId
    );

    if (!document || !document.storedName) {
      res.status(404).json({
        success: false,
        message: "Provider document not found.",
      });
      return;
    }

    const root = path.resolve(providerDocumentStorageRoot);
    const storedName = document.storedName;

    // Stored names are generated UUID filenames, never user-supplied paths.
    if (
      path.basename(storedName) !== storedName ||
      storedName.includes("/") ||
      storedName.includes("\\")
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid stored document reference.",
      });
      return;
    }

    const filePath = path.resolve(root, storedName);
    if (!filePath.startsWith(root + path.sep)) {
      res.status(400).json({
        success: false,
        message: "Invalid document path.",
      });
      return;
    }

    const fileInfo = await fs.stat(filePath);
    if (!fileInfo.isFile()) {
      res.status(404).json({
        success: false,
        message: "Provider document file not found.",
      });
      return;
    }

    const downloadName = path.basename(document.originalName || "provider-document");

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/octet-stream");
    res.download(filePath, downloadName, (error) => {
      if (error) {
        console.error("Provider document download failed:", error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: "Unable to download this provider document.",
          });
        }
      }
    });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;

    if (code === "ENOENT") {
      res.status(404).json({
        success: false,
        message: "Provider document file not found.",
      });
      return;
    }

    console.error("Get provider document failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to retrieve this provider document.",
    });
  }
}

export async function markProviderApplicationUnderReview(
  req: Request,
  res: Response
): Promise<void> {
  if (!isControlRoom(req, res)) return;

  const applicationId = req.params.applicationId;
  if (typeof applicationId !== "string") {
    res.status(400).json({
      success: false,
      message: "Invalid provider application ID.",
    });
    return;
  }
  if (!validApplicationId(applicationId, res)) return;

  try {
    const application = await ProviderApplication.findOneAndUpdate(
      {
        _id: applicationId,
        status: "PENDING_REVIEW",
      },
      {
        $set: {
          status: "UNDER_REVIEW",
          reviewedBy: req.user!.userId,
          reviewedAt: new Date(),
        },
        $unset: { rejectionReason: 1 },
      },
      { new: true, runValidators: true }
    );

    if (!application) {
      res.status(409).json({
        success: false,
        message:
          "Application not found or it is no longer awaiting initial review.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Provider application marked as under review.",
      application,
    });
  } catch (error) {
    console.error("Mark provider application under review failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to update the application review status.",
    });
  }
}

export async function approveProviderApplication(
  req: Request,
  res: Response
): Promise<void> {
  if (!isControlRoom(req, res)) return;

  const applicationId = req.params.applicationId;
  if (typeof applicationId !== "string") {
    res.status(400).json({
      success: false,
      message: "Invalid provider application ID.",
    });
    return;
  }
  if (!validApplicationId(applicationId, res)) return;

  try {
    const application = await ProviderApplication.findOne({
      _id: applicationId,
      status: "UNDER_REVIEW",
    });

    if (!application) {
      res.status(409).json({
        success: false,
        message:
          "Only applications marked UNDER_REVIEW can be approved.",
      });
      return;
    }

    const provider = await User.findOne({
      _id: application.userId,
      role: "PROVIDER",
    }).select("role emailVerified accountStatus");

    if (!provider) {
      res.status(404).json({
        success: false,
        message: "The provider account for this application was not found.",
      });
      return;
    }

    if (!provider.emailVerified) {
      res.status(409).json({
        success: false,
        message: "The provider must verify their email before approval.",
      });
      return;
    }

    if (provider.accountStatus !== "PENDING") {
      res.status(409).json({
        success: false,
        message:
          "The provider account is not pending approval. Check its account status before proceeding.",
      });
      return;
    }

    // Claim the application first so two reviewers cannot approve it at once.
    const claimed = await ProviderApplication.findOneAndUpdate(
      {
        _id: applicationId,
        status: "UNDER_REVIEW",
      },
      {
        $set: {
          status: "APPROVED",
          reviewedBy: req.user!.userId,
          reviewedAt: new Date(),
        },
        $unset: { rejectionReason: 1 },
      },
      { new: true, runValidators: true }
    );

    if (!claimed) {
      res.status(409).json({
        success: false,
        message: "Another reviewer has already changed this application.",
      });
      return;
    }

    const accountUpdate = await User.updateOne(
      {
        _id: application.userId,
        role: "PROVIDER",
        emailVerified: true,
        accountStatus: "PENDING",
      },
      {
        $set: { accountStatus: "APPROVED" },
      }
    );

    if (accountUpdate.modifiedCount !== 1) {
      // Roll the application back if the account could not be activated.
      await ProviderApplication.updateOne(
        {
          _id: applicationId,
          status: "APPROVED",
          reviewedBy: req.user!.userId,
        },
        {
          $set: { status: "UNDER_REVIEW" },
          $unset: { reviewedBy: 1, reviewedAt: 1 },
        }
      );

      res.status(409).json({
        success: false,
        message:
          "The provider account changed during approval. The application was returned to review; refresh and check the account.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message:
        "Provider approved. Email verification and Control Room review are complete.",
      application: claimed,
    });
  } catch (error) {
    console.error("Approve provider application failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to approve this provider application.",
    });
  }
}

export async function rejectProviderApplication(
  req: Request,
  res: Response
): Promise<void> {
  if (!isControlRoom(req, res)) return;

  const applicationId = req.params.applicationId;
  if (typeof applicationId !== "string") {
    res.status(400).json({
      success: false,
      message: "Invalid provider application ID.",
    });
    return;
  }
  if (!validApplicationId(applicationId, res)) return;

  const rejectionReason =
    typeof req.body?.rejectionReason === "string"
      ? req.body.rejectionReason.trim()
      : "";

  if (!rejectionReason || rejectionReason.length > 2000) {
    res.status(400).json({
      success: false,
      message: "Provide a rejection reason of 1–2000 characters.",
    });
    return;
  }

  try {
    const existingApplication = await ProviderApplication.findOne({
      _id: applicationId,
      status: { $in: ["PENDING_REVIEW", "UNDER_REVIEW"] },
    }).select("status userId");

    if (!existingApplication) {
      res.status(409).json({
        success: false,
        message:
          "Application not found or it has already been approved or rejected.",
      });
      return;
    }

    const previousStatus = existingApplication.status;

    const application = await ProviderApplication.findOneAndUpdate(
      {
        _id: applicationId,
        status: previousStatus,
      },
      {
        $set: {
          status: "REJECTED",
          rejectionReason,
          reviewedBy: req.user!.userId,
          reviewedAt: new Date(),
        },
      },
      { new: true, runValidators: true }
    );

    if (!application) {
      res.status(409).json({
        success: false,
        message: "Another reviewer has already changed this application.",
      });
      return;
    }

    const restoreApplication = async (): Promise<boolean> => {
      const rollback = await ProviderApplication.updateOne(
        {
          _id: applicationId,
          status: "REJECTED",
          reviewedBy: req.user!.userId,
        },
        {
          $set: { status: previousStatus },
          $unset: {
            rejectionReason: 1,
            reviewedBy: 1,
            reviewedAt: 1,
          },
        }
      );

      return rollback.modifiedCount === 1;
    };

    try {
      const provider = await User.findOne({
        _id: application.userId,
        role: "PROVIDER",
      }).select("accountStatus");

      if (!provider) {
        const restored = await restoreApplication();
        if (!restored) {
          console.error(
            "Provider rejection rollback failed: provider account not found.",
            applicationId
          );
        }

        res.status(409).json({
          success: false,
          message:
            "Provider account not found. The application was returned to its previous review status where possible.",
        });
        return;
      }

      // A suspended account remains suspended and cannot access protected APIs.
      if (provider.accountStatus !== "SUSPENDED") {
        const accountUpdate = await User.updateOne(
          {
            _id: application.userId,
            role: "PROVIDER",
            accountStatus: provider.accountStatus,
          },
          {
            $set: { accountStatus: "PENDING" },
            $unset: {
              refreshTokenHash: 1,
              refreshTokenExpiresAt: 1,
            },
          }
        );

        if (accountUpdate.matchedCount !== 1) {
          const restored = await restoreApplication();
          if (!restored) {
            console.error(
              "Provider rejection rollback failed after account update conflict.",
              applicationId
            );
          }

          res.status(409).json({
            success: false,
            message:
              "The provider account changed during rejection. The application was returned to its previous review status where possible.",
          });
          return;
        }
      }
    } catch (accountError) {
      try {
        const restored = await restoreApplication();
        if (!restored) {
          console.error(
            "Provider rejection rollback failed after account update error.",
            applicationId
          );
        }
      } catch (rollbackError) {
        console.error("Provider rejection rollback error:", rollbackError);
      }

      throw accountError;
    }

    res.status(200).json({
      success: true,
      message: "Provider application rejected.",
      application,
    });
  } catch (error) {
    console.error("Reject provider application failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to reject this provider application.",
    });
  }
}
