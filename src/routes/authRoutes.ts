import { Router } from "express";
import {
  register,
  login,
  verifyEmail,
  refreshAccessToken,
  requestPasswordReset,
  resetPassword,
} from "../controllers/authController.js";
import {
  registrationLimiter,
  emailVerificationLimiter,
  loginLimiter,
  passwordResetRequestLimiter,
  passwordResetSubmitLimiter,
} from "../middleware/rateLimiters.js";

const router = Router();

router.post("/register", registrationLimiter, register);
router.post("/verify-email", emailVerificationLimiter, verifyEmail);
router.post("/login", loginLimiter, login);
router.post("/refresh", refreshAccessToken);
router.post("/forgot-password", passwordResetRequestLimiter, requestPasswordReset);
router.post("/reset-password", passwordResetSubmitLimiter, resetPassword);

export default router;
