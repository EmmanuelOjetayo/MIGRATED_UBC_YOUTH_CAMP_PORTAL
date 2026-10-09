require("dotenv").config();

const mongoose = require("mongoose");
const { Client, Databases, Query } = require("node-appwrite");

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");
const YCMealLog = require("../Model/YCMealLog");
const YCSouvenir = require("../Model/YCSouvenir");

// ─────────────────────────────────────────────────────────────
// CAMP MIGRATION RECONCILIATION REPORT
//
// Compares the legacy Appwrite CAMP collections against the new
// CAMP Mongo collections and prints an honest pass/fail summary.
//
// Read-only: it never writes to Appwrite or MongoDB.
//
//   npm run verify:migration
// ─────────────────────────────────────────────────────────────

const requiredEnv = [
  "APPWRITE_ENDPOINT",
  "APPWRITE_PROJECT_ID",
  "APPWRITE_DATABASE_ID",
  "APPWRITE_API_KEY",
  "CAMP_MONGO_URL",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const appwriteClient = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(appwriteClient);

async function countAppwrite(collectionId) {
  let total = 0;
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      collectionId,
      [Query.limit(limit), Query.offset(offset)]
    );

    total += (response.documents || []).length;

    if ((response.documents || []).length < limit) break;

    offset += limit;
  }

  return total;
}

async function verify() {
  try {
    console.log("\n==============================================");
    console.log("🔍 CAMP MIGRATION RECONCILIATION REPORT");
    console.log("==============================================\n");

    const connectCamp = require("../config/campMongo");
    const { dbName } = await connectCamp();
    console.log(`✅ MongoDB connected to "${dbName}"\n`);

    // ── Appwrite source counts ──
    console.log("📊 APPWRITE CAMP (source)");
    const appwrite = {
      campers: await countAppwrite(process.env.APPWRITE_CAMPERS_COLLECTION),
      payments: await countAppwrite(process.env.APPWRITE_PAYMENTS_COLLECTION),
      mealLogs: await countAppwrite(process.env.APPWRITE_MEALLOGS_COLLECTION),
      souvenirs: await countAppwrite(process.env.APPWRITE_SOUVENIRS_COLLECTION),
    };

    console.log(`   Campers:   ${appwrite.campers}`);
    console.log(`   Payments:  ${appwrite.payments}`);
    console.log(`   MealLogs:  ${appwrite.mealLogs}`);
    console.log(`   Souvenirs: ${appwrite.souvenirs}`);

    // ── Mongo CAMP destination counts ──
    console.log("\n📊 MONGODB CAMP (destination)");
    const mongo = {
      YCUser: await YCUser.countDocuments(),
      YCPayment: await YCPayment.countDocuments(),
      YCMealLog: await YCMealLog.countDocuments(),
      YCSouvenir: await YCSouvenir.countDocuments(),
    };

    console.log(`   YCUser:     ${mongo.YCUser}`);
    console.log(`   YCPayment:  ${mongo.YCPayment}`);
    console.log(`   YCMealLog:  ${mongo.YCMealLog}`);
    console.log(`   YCSouvenir: ${mongo.YCSouvenir}`);

    // ── Integrity checks ──
    console.log("\n🔎 RELATIONSHIP INTEGRITY");

    const orphanedPayments = await YCPayment.countDocuments({
      camperId: { $nin: (await YCUser.find().select("_id")).map((u) => u._id) },
    });

    const campersNeedingPassword = await YCUser.countDocuments({
      $or: [{ password: null }, { password: { $exists: false } }],
    });

    const paidCampers = await YCUser.countDocuments({ status: "paid" });
    const assignedTeams = await YCUser.countDocuments({
      team: { $ne: null },
    });

    console.log(`   Orphaned payments:            ${orphanedPayments}`);
    console.log(`   Campers awaiting new password:${String(campersNeedingPassword).padStart(4)}`);
    console.log(`   Campers marked paid:          ${paidCampers}`);
    console.log(`   Campers with team assigned:   ${assignedTeams}`);

    // ── Reconciliation verdict ──
    console.log("\n📋 RECONCILIATION");

    const checks = [
      ["Campers", appwrite.campers, mongo.YCUser],
      ["Payments", appwrite.payments, mongo.YCPayment],
      ["MealLogs", appwrite.mealLogs, mongo.YCMealLog],
      ["Souvenirs", appwrite.souvenirs, mongo.YCSouvenir],
    ];

    let allMatched = true;

    for (const [label, source, dest] of checks) {
      // DEST may legitimately exceed SOURCE when the CAMP app has
      // created new records since migration. A shortfall is a problem.
      const ok = dest >= source;
      if (!ok) allMatched = false;

      const delta = dest - source;
      const deltaText = delta === 0 ? "=" : `+${delta}`;

      console.log(
        `   ${ok ? "✅" : "❌"} ${label.padEnd(10)} Appwrite ${String(source).padStart(4)}  →  Mongo ${String(dest).padStart(4)}  (${deltaText})`
      );
    }

    console.log("\n==============================================");
    if (allMatched) {
      console.log("✅ ALL APPWRITE CAMP DATA PRESENT IN MONGODB CAMP");
    } else {
      console.log("⚠️  DISCREPANCIES DETECTED — REVIEW REQUIRED");
    }
    console.log("==============================================\n");
  } catch (error) {
    console.error("\n❌ VERIFICATION FAILED\n");
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log("🔌 MongoDB connection closed.");
    }
  }
}

verify();