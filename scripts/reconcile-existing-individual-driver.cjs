require("dotenv").config();

const mongoose = require("mongoose");
const User = require(process.cwd() + "/dist/models/User.js").default;
const ProviderApplication =
  require(process.cwd() + "/dist/models/ProviderApplication.js").default;

const USER_ID = "6ad0eabf30c4c41e3210c003";
const EXPECTED_EMAIL = "maleseleelizabeth@gmail.com";
const VEHICLE_REGISTRATION = "NDB 123 GP";
const APPLY = process.env.APPLY_PROVIDER_RECONCILIATION === "YES";

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing; no changes made.");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findById(USER_ID).select(
    "fullName email role accountStatus emailVerified"
  ).lean();

  if (!user) {
    throw new Error("Expected existing user was not found; no changes made.");
  }

  if (user.email?.toLowerCase() !== EXPECTED_EMAIL) {
    throw new Error("User email does not match the expected account; no changes made.");
  }

  if (user.role !== "PROVIDER") {
    throw new Error("Account is not a PROVIDER; no changes made.");
  }

  if (user.emailVerified !== true) {
    throw new Error("Provider email is not verified; no changes made.");
  }

  const existingApplication = await ProviderApplication.findOne({
    userId: USER_ID,
  }).select("_id status providerType").lean();

  if (existingApplication) {
    throw new Error(
      `An application already exists (${existingApplication.status}); ` +
      "stopping to prevent duplicates or overwriting a review."
    );
  }

  const registrationConflict = await ProviderApplication.findOne({
    vehicleRegistrationNumber: VEHICLE_REGISTRATION,
  }).select("_id userId status").lean();

  if (registrationConflict) {
    throw new Error(
      "This vehicle registration is already recorded on another application; " +
      "verify ownership before proceeding."
    );
  }

  console.log("\n===== RECONCILIATION CHECK =====");
  console.log({
    userId: USER_ID,
    fullName: user.fullName,
    email: user.email,
    currentAccountStatus: user.accountStatus,
    applicationExists: false,
    providerType: "INDIVIDUAL_DRIVER",
    serviceArea: "South Africa",
    vehicleType: "mini bus toyota",
    vehicleRegistrationNumber: VEHICLE_REGISTRATION,
    applicationStatusAfterReconciliation: "PENDING_REVIEW",
    accountStatusAfterReconciliation: "PENDING",
    mode: APPLY ? "APPLY CHANGES" : "DRY RUN — NO CHANGES",
  });

  if (!APPLY) {
    console.log(
      "\nDry-run complete. Inspect the details above. " +
      "No database records were changed."
    );
    return;
  }

  // Do not downgrade an account that has changed since inspection.
  if (user.accountStatus !== "APPROVED") {
    throw new Error(
      `Expected account status APPROVED, found ${user.accountStatus}; ` +
      "stopping without changes."
    );
  }

  // Create the pending application first. It cannot qualify for assignment.
  const application = await ProviderApplication.create({
    userId: USER_ID,
    providerType: "INDIVIDUAL_DRIVER",
    vehicleType: "mini bus toyota",
    vehicleRegistrationNumber: VEHICLE_REGISTRATION,
    serviceArea: "South Africa",
    status: "PENDING_REVIEW",
    additionalNotes:
      "Legacy test account reconciled into the provider application workflow. " +
      "Control Room review and approval required before operating.",
  });

  try {
    // Revoke the legacy approval and refresh-token credentials.
    const result = await User.updateOne(
      {
        _id: USER_ID,
        role: "PROVIDER",
        accountStatus: "APPROVED",
        emailVerified: true,
      },
      {
        $set: { accountStatus: "PENDING" },
        $unset: {
          refreshTokenHash: 1,
          refreshTokenExpiresAt: 1,
        },
      }
    );

    if (result.modifiedCount !== 1) {
      throw new Error(
        "Account status changed concurrently; expected account update did not occur."
      );
    }
  } catch (error) {
    // Roll back only the application created by this execution.
    await ProviderApplication.deleteOne({
      _id: application._id,
      status: "PENDING_REVIEW",
    });
    throw error;
  }

  console.log("\nReconciliation completed.");
  console.log({
    userId: USER_ID,
    applicationId: application._id.toString(),
    applicationStatus: "PENDING_REVIEW",
    accountStatus: "PENDING",
    approvedAutomatically: false,
  });
}

main()
  .catch((error) => {
    console.error("\nReconciliation stopped:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
