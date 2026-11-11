
import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomInt, randomBytes, createHash } from "node:crypto";
import User from "../models/User.js";
import {
  sendEmailVerificationCode,
  sendPasswordResetCode,
} from "../services/emailService.js";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is missing from environment variables");
  }

  return secret;
}

function hashVerificationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function registerWithRole(
  req: Request,
  res: Response,
  role: "PATIENT" | "CONTROL_ROOM"
): Promise<void> {
  try {
    const { fullName, email, phoneNumber, password } = req.body;

    if (
      typeof fullName !== "string" ||
      typeof email !== "string" ||
      typeof phoneNumber !== "string" ||
      typeof password !== "string" ||
      !fullName.trim() ||
      !email.trim() ||
      !phoneNumber.trim()
    ) {
      res.status(400).json({
        success: false,
        message: "Full name, email, phone number and password are required.",
      });
      return;
    }

    if (password.length < 6 || password.length > 128 || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) {
      res.status(400).json({
        success: false,
        message: "Password must be 6–128 characters and include at least one number and one special character.",
      });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const code = randomInt(100000, 1000000).toString();
    const verificationCodeHash = hashVerificationCode(code);
    const verificationCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const user = await User.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      phoneNumber: phoneNumber.trim(),
      passwordHash,
      role,
      accountStatus: "PENDING",
      emailVerified: false,
      verificationCodeHash,
      verificationCodeExpiresAt,
    });

    try {
      await sendEmailVerificationCode(user.email, code);
    } catch (emailError) {
      await User.deleteOne({ _id: user._id });

      console.error("Verification email delivery failed:", emailError);

      res.status(503).json({
        success: false,
        message: "We could not send the verification email. Please try registering again.",
      });
      return;
    }

    res.status(201).json({
      success: true,
      message: "Account created. Check your email for the verification code.",
      email: user.email,
      expiresIn: 600,
    });
  } catch (error) {
    console.error("Registration failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to create account.",
    });
  }
}

export async function register(
  req: Request,
  res: Response
): Promise<void> {
  await registerWithRole(req, res, "PATIENT");
}

export async function registerControlRoom(
  req: Request,
  res: Response
): Promise<void> {
  await registerWithRole(req, res, "CONTROL_ROOM");
}

export async function verifyEmail(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { email, code } = req.body;

    if (
      typeof email !== "string" ||
      typeof code !== "string" ||
      !/^\d{6}$/.test(code)
    ) {
      res.status(400).json({
        success: false,
        message: "A valid email address and six-digit verification code are required.",
      });
      return;
    }

    const user = await User.findOne({
      email: email.trim().toLowerCase(),
    }).select("+verificationCodeHash +verificationCodeExpiresAt");

    if (!user || user.emailVerified || !user.verificationCodeHash) {
      res.status(400).json({
        success: false,
        message: "Invalid or expired verification code.",
      });
      return;
    }

    if (
      !user.verificationCodeExpiresAt ||
      user.verificationCodeExpiresAt.getTime() <= Date.now()
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid or expired verification code.",
      });
      return;
    }

    const submittedHash = hashVerificationCode(code);

    if (submittedHash !== user.verificationCodeHash) {
      res.status(400).json({
        success: false,
        message: "Invalid or expired verification code.",
      });
      return;
    }

    user.emailVerified = true;

    // Patients and Control Room accounts are approved after email verification.
    // Providers must remain pending until Control Room approval.
    if (user.role === "PATIENT" || user.role === "CONTROL_ROOM") {
      user.accountStatus = "APPROVED";
    }

    user.verificationCodeHash = undefined;
    user.verificationCodeExpiresAt = undefined;

    await user.save();

    res.status(200).json({
      success: true,
      message:
        user.role === "PROVIDER"
          ? "Email verified. Your provider application is awaiting Control Room review."
          : "Email verified successfully. Your account is approved. You can now log in.",
      accountStatus: user.accountStatus,
    });
  } catch (error) {
    console.error("Email verification failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to verify email.",
    });
  }
}

export async function login(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
      return;
    }

    const user = await User.findOne({
      email: email.trim().toLowerCase(),
    }).select("+passwordHash");

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
      return;
    }

    if (!user.emailVerified) {
      res.status(403).json({
        success: false,
        message: "Please verify your email before logging in.",
      });
      return;
    }

    if (user.accountStatus !== "APPROVED") {
      res.status(403).json({
        success: false,
        message: "Your account is not approved for access.",
      });
      return;
    }


    const token = jwt.sign(
      {
        sub: user.id,
        role: user.role,
      },
      getJwtSecret(),
      { expiresIn: "8h" }
    );

    const refreshToken = randomBytes(48).toString("hex");

    user.refreshTokenHash = hashRefreshToken(refreshToken);
    user.refreshTokenExpiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    );

    await user.save();

    res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      refreshToken,
      expiresIn: 28800,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    });


  } catch (error) {
    console.error("Login failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to log in.",
    });
  }
}

export async function requestPasswordReset(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { email } = req.body;

    if (typeof email !== "string" || !email.trim()) {
      res.status(400).json({
        success: false,
        message: "A valid email address is required.",
      });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select(
      "+passwordResetCodeHash +passwordResetCodeExpiresAt"
    );

    if (user) {
      const code = randomInt(100000, 1000000).toString();
      user.passwordResetCodeHash = hashVerificationCode(code);
      user.passwordResetCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();

      try {
        await sendPasswordResetCode(user.email, code);
      } catch (emailError) {
        console.error("Password reset email delivery failed:", emailError);
      }
    }

    res.status(200).json({
      success: true,
      message: "If an account exists for that email, a password reset code has been sent.",
    });
  } catch (error) {
    console.error("Password reset request failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to process the password reset request.",
    });
  }
}

export async function resetPassword(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { email, code, password } = req.body;

    if (
      typeof email !== "string" ||
      !email.trim() ||
      typeof code !== "string" ||
      !/^\d{6}$/.test(code) ||
      typeof password !== "string"
    ) {
      res.status(400).json({
        success: false,
        message: "Email, six-digit reset code and new password are required.",
      });
      return;
    }

    if (
      password.length < 6 ||
      password.length > 128 ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9\s]/.test(password)
    ) {
      res.status(400).json({
        success: false,
        message: "Password must be 6–128 characters and include at least one number and one special character.",
      });
      return;
    }

    const user = await User.findOne({
      email: email.trim().toLowerCase(),
    }).select(
      "+passwordHash +passwordResetCodeHash +passwordResetCodeExpiresAt +refreshTokenHash +refreshTokenExpiresAt"
    );

    if (
      !user ||
      !user.passwordResetCodeHash ||
      !user.passwordResetCodeExpiresAt ||
      user.passwordResetCodeExpiresAt.getTime() <= Date.now() ||
      hashVerificationCode(code) !== user.passwordResetCodeHash
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid or expired password reset code.",
      });
      return;
    }

    user.passwordHash = await bcrypt.hash(password, 12);
    user.passwordResetCodeHash = undefined;
    user.passwordResetCodeExpiresAt = undefined;

    // Revoke the existing refresh session after a password change.
    user.refreshTokenHash = undefined;
    user.refreshTokenExpiresAt = undefined;

    await user.save();

    res.status(200).json({
      success: true,
      message: "Password reset successfully. Please log in with your new password.",
    });
  } catch (error) {
    console.error("Password reset failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to reset your password.",
    });
  }
}

export async function refreshAccessToken(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { refreshToken } = req.body;

    if (
      typeof refreshToken !== "string" ||
      !/^[a-f0-9]{96}$/i.test(refreshToken)
    ) {
      res.status(401).json({
        success: false,
        message: "Refresh session is invalid. Please log in again.",
      });
      return;
    }

    const refreshTokenHash = hashRefreshToken(refreshToken);

    const user = await User.findOne({
      refreshTokenHash,
    }).select("+refreshTokenHash +refreshTokenExpiresAt");

    if (
      !user ||
      !user.refreshTokenExpiresAt ||
      user.refreshTokenExpiresAt.getTime() <= Date.now()
    ) {
      res.status(401).json({
        success: false,
        message: "Refresh session has expired. Please log in again.",
      });
      return;
    }

    if (!user.emailVerified || user.accountStatus !== "APPROVED") {
      res.status(401).json({
        success: false,
        message: "Your account cannot refresh this session.",
      });
      return;
    }

    const token = jwt.sign(
      {
        sub: user.id,
        role: user.role,
      },
      getJwtSecret(),
      { expiresIn: "8h" }
    );

    const newRefreshToken = randomBytes(48).toString("hex");

    user.refreshTokenHash = hashRefreshToken(newRefreshToken);
    user.refreshTokenExpiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    );

    await user.save();

    res.status(200).json({
      success: true,
      token,
      refreshToken: newRefreshToken,
      expiresIn: 28800,
    });
  } catch (error) {
    console.error("Token refresh failed:", error);

    res.status(500).json({
      success: false,
      message: "Unable to refresh your session.",
    });
  }
}

