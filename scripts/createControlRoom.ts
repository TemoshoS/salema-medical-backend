
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import User from "../src/models/User.js";

const rl = createInterface({ input, output });

async function main(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI is missing from your .env file.");
  }

  const fullName = (await rl.question("Control-room full name: ")).trim();
  const email = (await rl.question("Control-room email: "))
    .trim()
    .toLowerCase();
  const phoneNumber = (await rl.question("Control-room phone number: ")).trim();
  const password = await rl.question(
    "New password (minimum 12 characters): "
  );

  if (!fullName || !email || !phoneNumber) {
    throw new Error("Name, email, and phone number are required.");
  }

  if (password.length < 12 || password.length > 128) {
    throw new Error("Password must be between 12 and 128 characters.");
  }

  await mongoose.connect(mongoUri);

  const existingUser = await User.findOne({ email }).select("+passwordHash");

  if (existingUser) {
    throw new Error(
      "An account with this email already exists. No account was changed."
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await User.create({
    fullName,
    email,
    phoneNumber,
    passwordHash,
    role: "CONTROL_ROOM",
    accountStatus: "APPROVED",
    emailVerified: true,
  });

  console.log("\nControl-room account created successfully.");
  console.log(`Email: ${email}`);
  console.log("Role: CONTROL_ROOM");
  console.log("Account status: APPROVED");
  console.log("Email verified: true");
}

main()
  .catch((error: unknown) => {
    console.error(
      "\nCould not create control-room account:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    rl.close();
    await mongoose.disconnect();
  });
