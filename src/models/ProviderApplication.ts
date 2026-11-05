import mongoose, { Document, Schema, Types } from "mongoose";

export type ProviderType =
  | "AMBULANCE_COMPANY"
  | "MEDICAL_TRANSPORT_COMPANY"
  | "INDIVIDUAL_DRIVER";

export type ProviderApplicationStatus =
  | "PENDING_REVIEW"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED";

export type ProviderDocumentType =
  | "IDENTITY_DOCUMENT"
  | "DRIVERS_LICENCE"
  | "VEHICLE_REGISTRATION_OR_OWNERSHIP"
  | "INSURANCE"
  | "ROADWORTHINESS"
  | "PRDP"
  | "OPERATING_PERMIT";

export interface IProviderApplication extends Document {
  userId: Types.ObjectId;
  providerType: ProviderType;

  firstName: string;
  lastName: string;
  identityNumber: string;
  residentialAddress: string;

  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: number;
  passengerSeats: number;
  vehicleColour: string;
  wheelchairAccessible: boolean;

  documents: Array<{
    _id: Types.ObjectId;
    documentType: ProviderDocumentType;
    originalName: string;
    storedName: string;
    mimeType: string;
    size: number;
    uploadedAt: Date;
  }>;

  organisationName?: string;
  businessRegistrationNumber?: string;

  vehicleType?: string;
  vehicleRegistrationNumber?: string;
  operatingLicenceNumber?: string;
  qualificationsSummary?: string;

  serviceArea: string;
  additionalNotes?: string;

  status: ProviderApplicationStatus;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const ProviderApplicationSchema =
  new Schema<IProviderApplication>(
    {
      userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true,
        index: true,
      },

      providerType: {
        type: String,
        enum: [
          "AMBULANCE_COMPANY",
          "MEDICAL_TRANSPORT_COMPANY",
          "INDIVIDUAL_DRIVER",
        ],
        required: true,
      },

      firstName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80,
      },

      lastName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80,
      },

      identityNumber: {
        type: String,
        required: true,
        trim: true,
        maxlength: 40,
        select: false,
      },

      residentialAddress: {
        type: String,
        required: true,
        trim: true,
        maxlength: 500,
      },

      vehicleMake: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80,
      },

      vehicleModel: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80,
      },

      vehicleYear: {
        type: Number,
        required: true,
        min: 1950,
        max: 2100,
      },

      passengerSeats: {
        type: Number,
        required: true,
        min: 1,
        max: 100,
      },

      vehicleColour: {
        type: String,
        required: true,
        trim: true,
        maxlength: 50,
      },

      wheelchairAccessible: {
        type: Boolean,
        required: true,
        default: false,
      },

      documents: {
        type: [
          new Schema(
            {
              documentType: {
                type: String,
                enum: [
                  "IDENTITY_DOCUMENT",
                  "DRIVERS_LICENCE",
                  "VEHICLE_REGISTRATION_OR_OWNERSHIP",
                  "INSURANCE",
                  "ROADWORTHINESS",
                  "PRDP",
                  "OPERATING_PERMIT",
                ],
                required: true,
              },
              originalName: {
                type: String,
                required: true,
                maxlength: 255,
              },
              storedName: {
                type: String,
                required: true,
                select: false,
              },
              mimeType: {
                type: String,
                required: true,
                enum: ["application/pdf", "image/jpeg", "image/png"],
              },
              size: {
                type: Number,
                required: true,
                min: 1,
                max: 10 * 1024 * 1024,
              },
              uploadedAt: {
                type: Date,
                required: true,
                default: Date.now,
              },
            },
            { timestamps: false }
          ),
        ],
        default: [],
      },

      organisationName: {
        type: String,
        trim: true,
        maxlength: 160,
      },

      businessRegistrationNumber: {
        type: String,
        trim: true,
        maxlength: 100,
      },

      vehicleType: {
        type: String,
        trim: true,
        maxlength: 100,
      },

      vehicleRegistrationNumber: {
        type: String,
        trim: true,
        maxlength: 40,
      },

      operatingLicenceNumber: {
        type: String,
        trim: true,
        maxlength: 100,
      },

      qualificationsSummary: {
        type: String,
        trim: true,
        maxlength: 3000,
      },

      serviceArea: {
        type: String,
        required: true,
        trim: true,
        maxlength: 300,
      },

      additionalNotes: {
        type: String,
        trim: true,
        maxlength: 2000,
      },

      status: {
        type: String,
        enum: [
          "PENDING_REVIEW",
          "UNDER_REVIEW",
          "APPROVED",
          "REJECTED",
        ],
        default: "PENDING_REVIEW",
        required: true,
        index: true,
      },

      reviewedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
      },

      reviewedAt: {
        type: Date,
      },

      rejectionReason: {
        type: String,
        trim: true,
        maxlength: 2000,
      },
    },
    {
      timestamps: true,
    }
  );

ProviderApplicationSchema.index({
  status: 1,
  createdAt: 1,
});

export default mongoose.model<IProviderApplication>(
  "ProviderApplication",
  ProviderApplicationSchema
);
