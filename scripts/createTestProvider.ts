import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { createInterface } from "readline";
import { stdin, stdout } from "process";
import User from "../src/models/User.js";

const rl = createInterface({ input: stdin, output: stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI is missing from .env");
  }

  const fullName = (await ask("Test provider name: ")).trim();
  const email = (await ask("Test provider email: ")).trim().toLowerCase();
  const phoneNumber = (await ask("Test provider phone number: ")).trim();
  const password = await ask("Test provider password (12–128 characters): ");

  if (!fullName || !email || !phoneNumber) {
    throw new Error("Name, email, and phone number are required.");
  }

  if (password.length < 12 || password.length > 128) {
    throw new Error("Password must be between 12 and 128 characters.");
  }

  await mongoose.connect(mongoUri);

  try {
    const existing = await User.findOne({ email }).select("_id");

    if (existing) {
      throw new Error("That email already exists. No account was changed.");
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const provider = await User.create({
      fullName,
      email,
      phoneNumber,
      passwordHash,
      role: "PROVIDER",
      accountStatus: "APPROVED",
      emailVerified: true,
    });

    console.log("\nTest provider created successfully.");
    console.log(`Provider ID: ${provider.id}`);
    console.log(`Email: ${provider.email}`);
    console.log("Role: PROVIDER");
    console.log("Status: APPROVED");
    console.log("TEST ACCOUNT ONLY — not verified for real emergency work.");
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      "\nCould not create test provider:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(() => rl.close());
