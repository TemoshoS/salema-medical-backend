import "dotenv/config";
import mongoose from "mongoose";
import User from "../src/models/User.js";

async function main(): Promise<void> {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from .env");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const providers = await User.find({ role: "PROVIDER" })
      .select("_id fullName email accountStatus emailVerified")
      .lean();

    if (providers.length === 0) {
      console.log("No provider accounts exist.");
      return;
    }

    console.table(
      providers.map((provider) => ({
        id: String(provider._id),
        fullName: provider.fullName,
        email: provider.email,
        accountStatus: provider.accountStatus,
        emailVerified: provider.emailVerified,
      }))
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Could not check providers:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
});
