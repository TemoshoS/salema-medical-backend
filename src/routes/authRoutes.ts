import { Router } from "express";
import {
  register,
  login,
  verifyEmail,
  refreshAccessToken,
} from "../controllers/authController.js";
import {
  registrationLimiter,
  emailVerificationLimiter,
  loginLimiter,
} from "../middleware/rateLimiters.js";

const router = Router();

router.post("/register", registrationLimiter, register);
router.post("/verify-email", emailVerificationLimiter, verifyEmail);
router.post("/login", loginLimiter, login);
router.post("/refresh", refreshAccessToken);

export default router;
