import mongoose, { Schema, type Document } from "mongoose";

export interface IProviderPresence extends Document {
  userId: string;
  latitude: number;
  longitude: number;
  updatedAt: Date;
}

const ProviderPresenceSchema = new Schema<IProviderPresence>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
  },
  { timestamps: true }
);

ProviderPresenceSchema.index({ updatedAt: 1 });

export default mongoose.model<IProviderPresence>(
  "ProviderPresence",
  ProviderPresenceSchema
);
