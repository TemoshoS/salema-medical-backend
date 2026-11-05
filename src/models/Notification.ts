import mongoose, { Schema, Types } from "mongoose";

export interface INotification extends mongoose.Document {
  type: "PROVIDER_APPLICATION_SUBMITTED";
  title: string;
  message: string;
  path: string;
  kind: "provider";
  relatedEntityId: Types.ObjectId;
  readBy: Types.ObjectId[];
  dismissedBy: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    type: {
      type: String,
      enum: ["PROVIDER_APPLICATION_SUBMITTED"],
      required: true,
    },
    title: { type: String, required: true, maxlength: 160 },
    message: { type: String, required: true, maxlength: 500 },
    path: { type: String, required: true, default: "/provider-applications" },
    kind: { type: String, enum: ["provider"], required: true },
    relatedEntityId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    readBy: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
    dismissedBy: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
  },
  { timestamps: true }
);

NotificationSchema.index({ createdAt: -1 });

export default mongoose.model<INotification>("Notification", NotificationSchema);
