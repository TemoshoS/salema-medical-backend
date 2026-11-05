import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { randomInt, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import User from "../models/User.js";
import ProviderApplication from "../models/ProviderApplication.js";
import {
  sendEmailVerificationCode,
  sendProviderApplicationNotificationEmail,
} from "../services/emailService.js";
import Notification from "../models/Notification.js";
import {
  broadcastProviderApplicationNotification,
  getOnlineControlRoomUserIds,
} from "../services/medicalTrackingSocket.js";
import type {
  ProviderType,
  ProviderDocumentType,
} from "../models/ProviderApplication.js";
import { removeProviderFiles } from "../middleware/providerDocumentUpload.js";

const providerTypes: ProviderType[] = [
  "AMBULANCE_COMPANY",
  "MEDICAL_TRANSPORT_COMPANY",
  "INDIVIDUAL_DRIVER",
];

const documentTypes: ProviderDocumentType[] = [
  "IDENTITY_DOCUMENT",
  "DRIVERS_LICENCE",
  "VEHICLE_REGISTRATION_OR_OWNERSHIP",
  "INSURANCE",
  "ROADWORTHINESS",
  "PRDP",
  "OPERATING_PERMIT",
];

const requiredDocuments: ProviderDocumentType[] = [
  "IDENTITY_DOCUMENT",
  "DRIVERS_LICENCE",
  "VEHICLE_REGISTRATION_OR_OWNERSHIP",
  "INSURANCE",
];

function hashVerificationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function cleanOptional(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, maxLength);
}

function cleanFileName(value: string): string {
  return path.basename(value.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 255) || "provider-document";
}

function parseDocumentTypes(value: unknown): ProviderDocumentType[] | null {
  if (typeof value !== "string") return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (item) =>
          typeof item !== "string" ||
          !documentTypes.includes(item as ProviderDocumentType)
      )
    ) {
      return null;
    }

    return parsed as ProviderDocumentType[];
  } catch {
    return null;
  }
}

async function hasValidFileSignature(
  file: Express.Multer.File
): Promise<boolean> {
  const handle = await fs.open(file.path, "r");

  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    const signature = buffer.subarray(0, bytesRead);

    if (file.mimetype === "application/pdf") {
      return signature.subarray(0, 5).toString("ascii") === "%PDF-";
    }

    if (file.mimetype === "image/jpeg") {
      return (
        signature.length >= 3 &&
        signature[0] === 0xff &&
        signature[1] === 0xd8 &&
        signature[2] === 0xff
      );
    }

    if (file.mimetype === "image/png") {
      return signature.equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    }

    return false;
  } finally {
    await handle.close();
  }
}

export async function submitProviderApplication(
  req: Request,
  res: Response
): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  let createdUserId: string | undefined;

  try {
    const body = req.body ?? {};
    const {
      firstName,
      lastName,
      identityNumber,
      residentialAddress,
      email,
      phoneNumber,
      password,
      providerType,
      serviceArea,
    } = body;

    const first = typeof firstName === "string" ? firstName.trim() : "";
    const last = typeof lastName === "string" ? lastName.trim() : "";
    const fullName = `${first} ${last}`.trim();

    if (
      !first || first.length > 80 ||
      !last || last.length > 80 ||
      !fullName || fullName.length > 120 ||
      typeof identityNumber !== "string" ||
      !identityNumber.trim() ||
      identityNumber.trim().length > 40 ||
      typeof residentialAddress !== "string" ||
      !residentialAddress.trim() ||
      residentialAddress.trim().length > 500 ||
      typeof email !== "string" ||
      !email.trim() ||
      email.trim().length > 254 ||
      typeof phoneNumber !== "string" ||
      !phoneNumber.trim() ||
      phoneNumber.trim().length > 30 ||
      typeof password !== "string" ||
      password.length < 6 ||
      password.length > 128 ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9\s]/.test(password)
    ) {
      await removeProviderFiles(files);
      res.status(400).json({
        success: false,
        message: "Provide valid personal details. Password must be 6–128 characters and include a number and a special character.",
      });
      return;
    }

    if (
      typeof providerType !== "string" ||
      !providerTypes.includes(providerType as ProviderType)
    ) {
      await removeProviderFiles(files);
      res.status(400).json({
        success: false,
        message: "Select a valid provider category.",
      });
      return;
    }

    if (
      typeof serviceArea !== "string" ||
      !serviceArea.trim() ||
      serviceArea.trim().length > 300
    ) {
      await removeProviderFiles(files);
      res.status(400).json({
        success: false,
        message: "Enter the area in which you intend to provide services.",
      });
      return;
    }

    const vehicleMake = cleanOptional(body.vehicleMake, 80);
    const vehicleModel = cleanOptional(body.vehicleModel, 80);
    const vehicleColour = cleanOptional(body.vehicleColour, 50);
    const vehicleType = cleanOptional(body.vehicleType, 100);
    const vehicleRegistrationNumber = cleanOptional(
      body.vehicleRegistrationNumber, 40
    );

    const vehicleYear = Number(body.vehicleYear);
    const passengerSeats = Number(body.passengerSeats);

    const wheelchairAccessible =
      body.wheelchairAccessible === "true" ||
      body.wheelchairAccessible === true
        ? true
        : body.wheelchairAccessible === "false" ||
            body.wheelchairAccessible === false
          ? false
          : null;

    if (
      !vehicleMake ||
      !vehicleModel ||
      !vehicleColour ||
      !Number.isInteger(vehicleYear) ||
      vehicleYear < 1950 ||
      vehicleYear > new Date().getFullYear() + 1 ||
      !Number.isInteger(passengerSeats) ||
      passengerSeats < 1 ||
      passengerSeats > 100 ||
      wheelchairAccessible === null ||
      !vehicleType ||
      !vehicleRegistrationNumber
    ) {
      await removeProviderFiles(files);
      res.status(400).json({
        success: false,
        message: "Provide valid vehicle details, including make, model, year, registration, seats and accessibility.",
      });
      return;
    }

    const organisationName = cleanOptional(body.organisationName, 160);
    const businessRegistrationNumber = cleanOptional(
      body.businessRegistrationNumber, 100
    );
    const operatingLicenceNumber = cleanOptional(
      body.operatingLicenceNumber, 100
    );
    const qualificationsSummary = cleanOptional(
      body.qualificationsSummary, 3000
    );
    const additionalNotes = cleanOptional(body.additionalNotes, 2000);

    if (
      providerType !== "INDIVIDUAL_DRIVER" &&
      !organisationName
    ) {
      await removeProviderFiles(files);
      res.status(400).json({
        success: false,
        message: "Company applications must include the organisation name.",
      });
      return;
    }

    const submittedTypes = parseDocumentTypes(body.documentTypes);

    if (
      !submittedTypes ||
      submittedTypes.length !== files.length ||
      new Set(submittedTypes).size !== submittedTypes.length
    ) {
      await removeProviderFiles(files);
      res.status(400).json({
        success: false,
        message: "The uploaded documents do not match their document types.",
      });
      return;
    }

    const missingDocuments = requiredDocuments.filter(
      (type) => !submittedTypes.includes(type)
    );

    if (missingDocuments.length > 0) {
      await removeProviderFiles(files);
      res.status(400).json({
        success: false,
        message: "Upload your identity document, driver's licence, vehicle registration or ownership evidence, and insurance.",
        missingDocuments,
      });
      return;
    }

    for (const file of files) {
      if (
        file.size < 1 ||
        file.size > 10 * 1024 * 1024 ||
        !(await hasValidFileSignature(file))
      ) {
        await removeProviderFiles(files);
        res.status(400).json({
          success: false,
          message: "A document is invalid or its file content does not match its declared type. Upload genuine PDF, JPG or PNG files.",
        });
        return;
      }
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      await removeProviderFiles(files);
      res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const code = randomInt(100000, 1000000).toString();

    const user = await User.create({
      fullName,
      email: normalizedEmail,
      phoneNumber: phoneNumber.trim(),
      passwordHash,
      role: "PROVIDER",
      accountStatus: "PENDING",
      emailVerified: false,
      verificationCodeHash: hashVerificationCode(code),
      verificationCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    createdUserId = user.id;

    const documents = files.map((file, index) => ({
      documentType: submittedTypes[index],
      originalName: cleanFileName(file.originalname),
      storedName: file.filename,
      mimeType: file.mimetype,
      size: file.size,
      uploadedAt: new Date(),
    }));

    const application = await ProviderApplication.create({
      userId: user._id,
      providerType: providerType as ProviderType,
      firstName: first,
      lastName: last,
      identityNumber: identityNumber.trim(),
      residentialAddress: residentialAddress.trim(),
      vehicleMake,
      vehicleModel,
      vehicleYear,
      passengerSeats,
      vehicleColour,
      wheelchairAccessible,
      documents,
      organisationName,
      businessRegistrationNumber,
      vehicleType,
      vehicleRegistrationNumber,
      operatingLicenceNumber,
      qualificationsSummary,
      serviceArea: serviceArea.trim(),
      additionalNotes,
      status: "PENDING_REVIEW",
    });

    try {
      await sendEmailVerificationCode(user.email, code);
    } catch (emailError) {
      await ProviderApplication.deleteOne({ userId: user._id });
      await User.deleteOne({ _id: user._id });
      createdUserId = undefined;
      await removeProviderFiles(files);

      console.error("Provider verification email delivery failed:", emailError);
      res.status(503).json({
        success: false,
        message: "We could not send the verification email. Please try again later.",
      });
      return;
    }

    // Notify Control Room only after the applicant's verification email succeeds.
    // Notification delivery must never roll back a successfully submitted application.
    try {
      const displayName =
        (typeof organisationName === "string" && organisationName.trim()) ||
        `${first} ${last}`.trim();

      const notificationMessage =
        `${displayName} submitted a ${String(providerType).replaceAll("_", " ").toLowerCase()} application for ${serviceArea.trim()}.`;

      const notification = await Notification.create({
        type: "PROVIDER_APPLICATION_SUBMITTED",
        title: "New provider application",
        message: notificationMessage,
        path: "/provider-applications",
        kind: "provider",
        relatedEntityId: application._id,
      });

      const livePayload = {
        id: notification._id.toString(),
        title: notification.title,
        message: notification.message,
        path: notification.path,
        kind: notification.kind,
        createdAt: notification.createdAt,
        read: false,
      };

      const onlineControlRoomIds = await getOnlineControlRoomUserIds();

      if (onlineControlRoomIds.length > 0) {
        broadcastProviderApplicationNotification(livePayload);
      } else {
        const controlRoomUsers = await User.find({
          role: "CONTROL_ROOM",
          accountStatus: "APPROVED",
          emailVerified: true,
        }).select("email").lean();

        const recipients = [
          ...new Set(
            controlRoomUsers
              .map((item) => item.email)
              .filter((email): email is string => Boolean(email))
          ),
        ];

        if (recipients.length > 0) {
          await sendProviderApplicationNotificationEmail(recipients, {
            displayName,
            providerType: String(providerType),
            serviceArea: serviceArea.trim(),
          });
        } else {
          console.warn(
            "Provider application saved, but no approved and verified Control Room email recipients were found."
          );
        }
      }
    } catch (notificationError) {
      console.error(
        "Provider application was saved, but Control Room notification delivery failed:",
        notificationError
      );
    }

    res.status(201).json({
      success: true,
      message: "Provider application submitted. Verify your email; Control Room approval is required before operating.",
      email: user.email,
      providerType,
      applicationStatus: "PENDING_REVIEW",
      accountStatus: "PENDING",
      expiresIn: 600,
    });
  } catch (error) {
    await removeProviderFiles(files);

    if (createdUserId) {
      await ProviderApplication.deleteOne({ userId: createdUserId }).catch(() => undefined);
      await User.deleteOne({ _id: createdUserId }).catch(() => undefined);
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
      return;
    }

    console.error("Provider application submission failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to submit provider application.",
    });
  }
}
