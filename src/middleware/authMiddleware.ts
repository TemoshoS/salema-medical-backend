
import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import User from "../models/User.js";
import type { UserRole } from "../models/User.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: UserRole;
      };
    }
  }
}

export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      message: "Authentication required. Please log in.",
    });
    return;
  }

  const token = authorization.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    res.status(500).json({
      success: false,
      message: "Authentication is not configured.",
    });
    return;
  }

  let payload: JwtPayload;

  // Verify the JWT signature and expiry first.
  try {
    const decoded = jwt.verify(token, secret);

    if (
      typeof decoded === "string" ||
      typeof decoded.sub !== "string" ||
      !decoded.sub
    ) {
      res.status(401).json({
        success: false,
        message: "Invalid access token.",
      });
      return;
    }

    payload = decoded;
  } catch {
    res.status(401).json({
      success: false,
      message: "Invalid or expired access token. Please log in again.",
    });
    return;
  }

  // Check the current account in MongoDB.
  try {
    const user = await User.findById(payload.sub).select(
      "role accountStatus emailVerified"
    );

    if (!user || !user.emailVerified) {
      res.status(401).json({
        success: false,
        message: "Account not found or email not verified. Please log in again.",
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

    // Use the current database role, not a potentially outdated JWT role.
    req.user = {
      userId: user.id,
      role: user.role,
    };

    next();
  } catch (error) {
    console.error("Authentication account check failed:", error);

    res.status(500).json({
      success: false,
      message: "Unable to verify account access.",
    });
  }
}
