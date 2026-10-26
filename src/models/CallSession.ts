import mongoose, { Schema, Document } from "mongoose";
import { randomUUID } from "node:crypto";

export type CallType = "VIDEO" | "AUDIO";

export type CallSessionStatus =
  | "RINGING"
  | "ACCEPTED"
  | "DECLINED"
  | "ENDED"
  | "MISSED"
  | "CANCELLED";

export interface ICallSession extends Document {
  callSessionId: string;
  requestId?: string;
  callerUserId: string;
  callerRole: "PATIENT" | "CONTROL_ROOM" | "PROVIDER";
  recipientUserId: string;
  recipientRole: "PATIENT" | "CONTROL_ROOM" | "PROVIDER";
  callType: CallType;
  status: CallSessionStatus;
  roomName: string;
  startedAt?: Date;
  acceptedAt?: Date;
  endedAt?: Date;
  outcome?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CallSessionSchema = new Schema<ICallSession>(
  {
    callSessionId: {
      type: String,
      default: () => randomUUID(),
      unique: true,
      index: true,
    },
    requestId: {
      type: String,
      required: false,
      index: true,
    },
    callerUserId: {
      type: String,
      required: true,
      index: true,
    },
    callerRole: {
      type: String,
      enum: ["PATIENT", "CONTROL_ROOM", "PROVIDER"],
      required: true,
    },
    recipientUserId: {
      type: String,
      required: true,
      index: true,
    },
    recipientRole: {
      type: String,
      enum: ["PATIENT", "CONTROL_ROOM", "PROVIDER"],
      required: true,
    },
    callType: {
      type: String,
      enum: ["VIDEO", "AUDIO"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "RINGING",
        "ACCEPTED",
        "DECLINED",
        "ENDED",
        "MISSED",
        "CANCELLED",
      ],
      default: "RINGING",
      required: true,
      index: true,
    },
    roomName: {
      type: String,
      required: true,
      unique: true,
    },
    startedAt: Date,
    acceptedAt: Date,
    endedAt: Date,
    outcome: {
      type: String,
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
  }
);

CallSessionSchema.index({ requestId: 1, createdAt: -1 });
CallSessionSchema.index({ recipientUserId: 1, status: 1, createdAt: -1 });

export default mongoose.model<ICallSession>(
  "CallSession",
  CallSessionSchema
);
