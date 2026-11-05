
import mongoose, { Schema, Document } from "mongoose";

export type UserRole = "PATIENT" | "CONTROL_ROOM" | "PROVIDER";

export type AccountStatus = "PENDING" | "APPROVED" | "SUSPENDED";

export interface IUser extends Document {
  fullName: string;
  email: string;
  phoneNumber: string;
  passwordHash: string;
  role: UserRole;
  accountStatus: AccountStatus;
  emailVerified: boolean;
  verificationCodeHash?: string;
  verificationCodeExpiresAt?: Date;
  passwordResetCodeHash?: string;
  passwordResetCodeExpiresAt?: Date;

  refreshTokenHash?: string;
  refreshTokenExpiresAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["PATIENT", "CONTROL_ROOM", "PROVIDER"],
      default: "PATIENT",
      required: true,
    },
    accountStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "SUSPENDED"],
      default: "PENDING",
      required: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
      required: true,
    },
    verificationCodeHash: {
      type: String,
      select: false,
    },
    verificationCodeExpiresAt: {
      type: Date,
      select: false,
    },
    passwordResetCodeHash: {
      type: String,
      select: false,
    },
    passwordResetCodeExpiresAt: {
      type: Date,
      select: false,
    },

    refreshTokenHash: {
      type: String,
      select: false,
    },
    refreshTokenExpiresAt: {
      type: Date,
      select: false,
    },

  },
  {
    timestamps: true,
  }
);



export default mongoose.model<IUser>("User", UserSchema);
