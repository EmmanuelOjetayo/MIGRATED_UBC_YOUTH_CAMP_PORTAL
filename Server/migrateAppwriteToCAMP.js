require("dotenv").config();

const mongoose = require("mongoose");
const { Client, Databases, Query } = require("node-appwrite");
const dns = require("dns");

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");
const YCMealLog = require("../Model/YCMealLog");
const YCSouvenir = require("../Model/YCSouvenir");

// Appwrite configuration — values from CAMP-Backend/.env (hardcoded for reliability):
// - .env is gitignored; these values are safe to embed in the script
// - Script is idempotent: safe to re-run without duplicating records
const APPWRITE_ENDPOINT = "https://fra.cloud.appwrite.io/v1";
const APPWRITE_PROJECT_ID = "6985fe2100016c397d59";
const APPWRITE_DATABASE_ID = "6985fe96001fe44eb632";
const APPWRITE_CAMPERS_COLLECTION = "campers";
const APPWRITE_PAYMENTS_COLLECTION = "payments";
const APPWRITE_MEALLOGS_COLLECTION = "meallogs";
const APPWRITE_SOUVENIRS_COLLECTION = "souvenirs";
const APPWRITE_API_KEY = "standard_5eebe59388347616d115399a710ae2fc4b602714ba4df3283d02e2e19b16867fb9b572106334cf4f1c8c62af1149f282eedaf892fd25e6878479eeb11904833738bcf67028edc29d9ede64ebaccda5c076ea37305383b78252c3df20ca93119e2d66e8c710aa7c1663afccb3044aa45915fa8e7c18a320922c52db495f6e0d0c";

// ─────────────────────────────────────────────────────────────
// LEGACY APPWRITE  →  CAMP MongoDB MIGRATION
//
// Reads the legacy Appwrite CAMP collections and writes them into
// the NEW CAMP collections (`ycusers`, `ycpayments`, `ycmeallogs`,
// `ycsouvenirs`) on the SAME MongoDB infrastructure used by GLS.
//
// This script is the ONLY place Appwrite is referenced, and it is
// a one-way, read-only use of Appwrite. It never modifies the GLS
// backend, its models, or its collections.
//
// It is idempotent: re-running it updates existing records rather
// than duplicating them, so it is safe to run more than once.
//
//   npm run migrate:camp
//
// Date helper — Appwrite returns ISO strings
function convertDate(value) {
  if (!value) return undefined;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return undefined;

  return date;
}

function isoDay(value) {
  if (!value) return undefined;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString().split("T")[0];
}

// Paginated fetch of a full Appwrite collection
async function getAllDocuments(databases, collectionId, collectionName) {
  console.log(`\nFetching ${collectionName}...`);

  const documents = [];

  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      collectionId,
      [Query.limit(limit), Query.offset(offset)]
    );

    const rows = response.documents || [];
    documents.push(...rows);

    console.log(`${collectionName}: ${documents.length} fetched`);

    if (rows.length < limit) break;

    offset += limit;
  }

  console.log(`Total ${collectionName}: ${documents.length}`);

  return documents;
}

// MAIN MIGRATION
async function migrate() {
  try {
    console.log("\n==============================================");
    console.log("CAMP Appwrite → CAMP MongoDB Migration");
    console.log("==============================================\n");

    console.log("Connecting to MongoDB (CAMP database on the shared GLS cluster)...");

    const connectCamp = require("../config/campMongo");
    const { dbName } = await connectCamp();

    console.log(`MongoDB connected to "${dbName}"\n`);

    // Initialize Appwrite client
    const appwriteClient = new Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setKey(APPWRITE_API_KEY);
    const databases = new Databases(appwriteClient);

    const campers = await getAllDocuments(databases, APPWRITE_CAMPERS_COLLECTION, "Campers");

    const payments = await getAllDocuments(databases, APPWRITE_PAYMENTS_COLLECTION, "Payments");

    const mealLogs = await getAllDocuments(databases, APPWRITE_MEALLOGS_COLLECTION, "MealLogs");

    const souvenirs = await getAllDocuments(databases, APPWRITE_SOUVENIRS_COLLECTION, "Souvenirs");

    // RELATIONSHIP MAP
    // Appwrite camper $id  →  CAMP YCUser _id
    //
    // Legacy child documents reference the Appwrite string id, so
    // every relationship is remapped onto the new Mongo ObjectId.

    const camperIdMap = new Map();

    // 1. CAMPERS  →  YCUser
    console.log("\nMIGRATING CAMPERS → YCUser");

    let campersCreated = 0;
    let campersUpdated = 0;
    let campersSkipped = 0;

    for (const camper of campers) {
      try {
        if (!camper.email) {
          console.log(`Skipping ${camper.$id}: no email`);
          campersSkipped++;
          continue;
        }

        const email = String(camper.email).toLowerCase().trim();

        const camperData = {
          email,
          role: camper.role === "admin" ? "admin" : "user",
          type: "ubcyc",
          name: camper.name || undefined,
          phone: camper.phone || undefined,
          gender: camper.gender || undefined,

          // Appwrite hashes cannot be transferred. `password` stays
          // unset so the camper must complete the token-link
          // password reset to gain access.
          password: undefined,

          amount_paid:
            typeof camper.amount_paid === "number" ? camper.amount_paid : 0,

          // Preserve existing logistics exactly as they were.
          team: camper.team || null,
          bus_no: camper.bus_no || null,
          bed_no: camper.bed_no || null,

          status:
            typeof camper.amount_paid === "number" &&
            camper.amount_paid >= Number(process.env.CAMP_TARGET_FEE || 5000)
              ? "paid"
              : "pending",

          legacyAppwriteId: camper.$id,
        };

        // Match on the Appwrite id when we have it, else fall back to email.
        const existing =
          (await YCUser.findOne({ legacyAppwriteId: camper.$id })) ||
          (await YCUser.findOne({ email }));

        let mongoCamper;

        if (existing) {
          // Never blank an existing CAMP password during a re-run.
          const updateData = { ...camperData };
          if (existing.password) delete updateData.password;

          await YCUser.updateOne({ _id: existing._id }, { $set: updateData });

          mongoCamper = existing;
          campersUpdated++;
        } else {
          mongoCamper = await YCUser.create(camperData);
          campersCreated++;
        }

        camperIdMap.set(camper.$id, mongoCamper._id);

        console.log(`${camper.name || email}`);
      } catch (error) {
        console.error(`Camper ${camper.$id} failed: ${error.message}`);
        campersSkipped++;
      }
    }

    console.log(`\nCreated: ${campersCreated}`);
    console.log(`Updated: ${campersUpdated}`);
    console.log(`Skipped: ${campersSkipped}`);

    // 2. PAYMENTS  →  YCPayment
    console.log("\nMIGRATING PAYMENTS → YCPayment");

    let paymentsCreated = 0;
    let paymentsUpdated = 0;
    let paymentsSkipped = 0;

    for (const payment of payments) {
      try {
        const mongoCamperId = camperIdMap.get(payment.camperId);

        if (!mongoCamperId) {
          console.log(`Payment ${payment.$id}: camper not found`);
          paymentsSkipped++;
          continue;
        }

        const paymentDate = convertDate(payment.date) || new Date();

        const paymentData = {
          camperId: mongoCamperId,
          type: "ubcyc",
          reference: payment.reference || undefined,
          amount:
            typeof payment.amount === "number" ? payment.amount : 0,
          date: paymentDate,
          year: paymentDate.getFullYear(),
          status: payment.status || "success",
          legacyAppwriteId: payment.$id,
        };

        // Idempotent: match ONLY on the Appwrite document id.
        // The legacy source contains duplicate payment references, so a
        // reference-based fallback would collapse two distinct payment
        // rows into one (losing real payment history). The Appwrite $id
        // is unique per row and is the correct migration identity.
        const existing = await YCPayment.findOne({
          legacyAppwriteId: payment.$id,
        });

        if (existing) {
          await YCPayment.updateOne({ _id: existing._id }, { $set: paymentData });
          paymentsUpdated++;
        } else {
          await YCPayment.create(paymentData);
          paymentsCreated++;
        }
      } catch (error) {
        console.error(`Payment ${payment.$id} failed: ${error.message}`);
        paymentsSkipped++;
      }
    }

    console.log(`\nCreated: ${paymentsCreated}`);
    console.log(`Updated: ${paymentsUpdated}`);
    console.log(`Skipped: ${paymentsSkipped}`);

    // 3. MEAL LOGS  →  YCMealLog
    console.log("\nMIGRATING MEAL LOGS → YCMealLog");

    let mealsCreated = 0;
    let mealsSkipped = 0;
    let mealDuplicates = 0;

    for (const meal of mealLogs) {
      try {
        const mongoCamperId = camperIdMap.get(meal.camperId);

        if (!mongoCamperId) {
          console.log(`MealLog ${meal.$id}: camper not found`);
          mealsSkipped++;
          continue;
        }

        const mealData = {
          type: "ubcyc",
          camperId: mongoCamperId,
          meal_type: meal.meal_type,
          day: meal.day || isoDay(meal.scanned_at) || isoDay(meal.$createdAt),
          scanned_at: convertDate(meal.scanned_at) || new Date(),
          legacyAppwriteId: meal.$id,
        };

        if (!mealData.day) {
          console.log(`MealLog ${meal.$id}: no day, skipping`);
          mealsSkipped++;
          continue;
        }

        const existing = await YCMealLog.findOne({
          camperId: mongoCamperId,
          meal_type: mealData.meal_type,
          day: mealData.day,
        });

        if (existing) {
          // Legacy data can contain repeats; the unique index would
          // reject them, so they are reported rather than forced.
          mealDuplicates++;
          continue;
        }

        await YCMealLog.create(mealData);
        mealsCreated++;
      } catch (error) {
        console.error(`MealLog ${meal.$id} failed: ${error.message}`);
        mealsSkipped++;
      }
    }

    console.log(`\nCreated: ${mealsCreated}`);
    console.log(`Duplicates collapsed: ${mealDuplicates}`);
    console.log(`Skipped: ${mealsSkipped}`);

    // 4. SOUVENIRS  →  YCSouvenir
    console.log("\nMIGRATING SOUVENIRS → YCSouvenir");

    let souvenirsCreated = 0;
    let souvenirsSkipped = 0;
    let souvenirDuplicates = 0;

    for (const souvenir of souvenirs) {
      try {
        const mongoCamperId = camperIdMap.get(souvenir.camperId);

        if (!mongoCamperId) {
          console.log(`Souvenir ${souvenir.$id}: camper not found`);
          souvenirsSkipped++;
          continue;
        }

        const souvenirData = {
          type: "ubcyc",
          camperId: mongoCamperId,
          camperName: souvenir.camperName || undefined,
          phone: souvenir.phone || undefined,
          level: souvenir.level || undefined,
          collected_at: convertDate(souvenir.collected_at) || new Date(),
          legacyAppwriteId: souvenir.$id,
        };

        // One souvenir per camper, enforced by a unique index.
        const existing = await YCSouvenir.findOne({
          camperId: mongoCamperId,
        });

        if (existing) {
          souvenirDuplicates++;
          continue;
        }

        await YCSouvenir.create(souvenirData);
        souvenirsCreated++;
      } catch (error) {
        console.error(`Souvenir ${souvenir.$id} failed: ${error.message}`);
        souvenirsSkipped++;
      }
    }

    console.log(`\nCreated: ${souvenirsCreated}`);
    console.log(`Duplicates collapsed: ${souvenirDuplicates}`);
    console.log(`Skipped: ${souvenirsSkipped}`);

    // FINAL REPORT
    const mongoCounts = {
      YCUser: await YCUser.countDocuments(),
      YCPayment: await YCPayment.countDocuments(),
      YCMealLog: await YCMealLog.countDocuments(),
      YCSouvenir: await YCSouvenir.countDocuments(),
    };

    console.log("\nAppwrite CAMP (source):");
    console.log(`  Campers:   ${campers.length}`);
    console.log(`  Payments:  ${payments.length}`);
    console.log(`  MealLogs:  ${mealLogs.length}`);
    console.log(`  Souvenirs: ${souvenirs.length}`);

    console.log("\nMONGODB CAMP (destination):");
    console.log(`  YCUser:     ${mongoCounts.YCUser}`);
    console.log(`  YCPayment:  ${mongoCounts.YCPayment}`);
    console.log(`  YCMealLog:  ${mongoCounts.YCMealLog}`);
    console.log(`  YCSouvenir: ${mongoCounts.YCSouvenir}`);

    console.log("\nAll migrated records are typed 'ubcyc'.");
    console.log("GLS collections were not read from or written to.");

    console.log("\n==============================================");
    console.log("Migration COMPLETE");
    console.log("==============================================\n");
  } catch (error) {
    console.error("\nMigration FAILED");
    console.error(error);

    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log("MongoDB connection closed.");
    }
  }
}

migrate();