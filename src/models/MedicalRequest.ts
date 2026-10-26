
import mongoose, { Schema, Document } from "mongoose";
import { randomUUID } from "node:crypto";

export type MedicalServiceType =
  | "EMERGENCY_AMBULANCE"
  | "MEDICAL_TRANSPORT";

export type MedicalRequestStatus =
  | "REQUEST_SUBMITTED"
  | "CONTROL_ROOM_REVIEWING"
  | "PROVIDER_BEING_CONTACTED"
  | "PROVIDER_ACCEPTED"
  | "DISPATCHED"
  | "ON_THE_WAY"
  | "ARRIVED_AT_PICKUP"
  | "PATIENT_TRANSPORTING"
  | "COMPLETED"
  | "ASSISTANCE_NOT_CONFIRMED"
  | "CANCELLED";

interface ICoordinates {
  latitude?: number;
  longitude?: number;
}

interface IProviderLocation {
  latitude: number;
  longitude: number;
  updatedAt: Date;
}

export interface IMedicalRequest extends Document {
  requestId: string;
  userId: string;
  callbackNumber: string;
  serviceType: MedicalServiceType;
  urgencyLevel: "EMERGENCY" | "NON_EMERGENCY";
  description?: string;
  pickupAddress: string;
  pickupLocation?: ICoordinates;
  pickupLocationVerified: boolean;
  destinationAddress?: string;
  destinationLocation?: ICoordinates;
  requestedDateTime?: Date;
  wheelchairRequired: boolean;
  companionTravelling: boolean;
  transportNotes?: string;
  status: MedicalRequestStatus;
  assignedAdminId?: string;
  assignedProviderId?: string;
  dispatchConfirmedAt?: Date;
  providerLocation?: IProviderLocation;
  createdAt: Date;
  updatedAt: Date;
}

const MedicalRequestSchema = new Schema<IMedicalRequest>(
  {
    requestId: {
      type: String,
      default: () => randomUUID(),
      unique: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    callbackNumber: {
      type: String,
      required: true,
      trim: true,
    },
    serviceType: {
      type: String,
      enum: ["EMERGENCY_AMBULANCE", "MEDICAL_TRANSPORT"],
      required: true,
    },
    urgencyLevel: {
      type: String,
      enum: ["EMERGENCY", "NON_EMERGENCY"],
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    pickupAddress: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    pickupLocation: {
      latitude: {
        type: Number,
        min: -90,
        max: 90,
      },
      longitude: {
        type: Number,
        min: -180,
        max: 180,
      },
    },
    pickupLocationVerified: {
      type: Boolean,
      default: false,
    },
    destinationAddress: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    destinationLocation: {
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
    },
    requestedDateTime: Date,
    wheelchairRequired: {
      type: Boolean,
      default: false,
    },
    companionTravelling: {
      type: Boolean,
      default: false,
    },
    transportNotes: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: [
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
      ],
      default: "REQUEST_SUBMITTED",
      required: true,
      index: true,
    },
    assignedAdminId: String,
    assignedProviderId: String,
    dispatchConfirmedAt: Date,
    providerLocation: {
      latitude: {
        type: Number,
        min: -90,
        max: 90,
      },
      longitude: {
        type: Number,
        min: -180,
        max: 180,
      },
      updatedAt: Date,
    },
  },
  {
    timestamps: true,
  }
);

MedicalRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<IMedicalRequest>(
  "MedicalRequest",
  MedicalRequestSchema
);
