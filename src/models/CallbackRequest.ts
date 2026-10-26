import mongoose, { Schema, Document } from "mongoose";
import { randomUUID } from "node:crypto";

export type CallbackRequestStatus =
  | "CALLBACK_PENDING"
  | "CALLBACK_IN_PROGRESS"
  | "CALLBACK_COMPLETED"
  | "CALLBACK_CANCELLED";

export interface ICallbackRequest extends Document {
  callbackRequestId: string;
  userId: string;
  callbackNumber: string;
  reason: string;
  status: CallbackRequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

const CallbackRequestSchema = new Schema<ICallbackRequest>(
  {
    callbackRequestId: {
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
      maxlength: 30,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: [
        "CALLBACK_PENDING",
        "CALLBACK_IN_PROGRESS",
        "CALLBACK_COMPLETED",
        "CALLBACK_CANCELLED",
      ],
      default: "CALLBACK_PENDING",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

CallbackRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<ICallbackRequest>(
  "CallbackRequest",
  CallbackRequestSchema
);
