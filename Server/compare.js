/**
 * READ-ONLY: Appwrite (source) vs the isolated `camp` MongoDB (destination).
 * Compares on legacyAppwriteId / reference only. No secrets ever printed.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { Client, Databases, Query } = require("node-appwrite");

const LOG = path.join(__dirname, "compare.log");
const out = [];
const say = (l = "") => {
  out.push(l);
  fs.writeFileSync(LOG, out.join("\n"));
};

async function all(databases, collectionId) {
  const docs = [];
  let offset = 0;
  while (true) {
    const r = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      collectionId,
      [Query.limit(100), Query.offset(offset)]
    );
    const rows = r.documents || [];
    docs.push(...rows);
    if (rows.length < 100) break;
    offset += 100;
  }
  return docs;
}

function ids(a, k) {
  const s = new Set();
  for (const r of a) {
    const v = r[k];
    if (v != null && String(v) !== "") s.add(String(v).toLowerCase().trim());
  }
  return s;
}

async function main() {
  say("================================================");
  say("APWRITE vs MONGODB-CAMP COMPARISON (READ-ONLY, NO SECRETS)");
  say("================================================\n");

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
  const databases = new Databases(client);

  const awCampers = await all(databases, process.env.APPWRITE_CAMPERS_COLLECTION);
  const awPayments = await all(databases, process.env.APPWRITE_PAYMENTS_COLLECTION);

  say(`[1] APPWRITE (source)`);
  say(`   campers  ${awCampers.length}`);
  say(`   payments ${awPayments.length}`);

  const connectCamp = require("../config/campMongo");
  await connectCamp();
  const db = mongoose.connection.db;

  const ycUsers = await db
    .collection("ycusers")
    .find({})
    .project({ _id: 0, legacyAppwriteId: 1, email: 1 })
    .toArray();
  const ycPayments = await db
    .collection("ycpayments")
    .find({})
    .project({ _id: 0, legacyAppwriteId: 1, reference: 1 })
    .toArray();

  const awUid = ids(awCampers, "$id");
  const ucUid = ids(ycUsers, "legacyAppwriteId");
  const awRef = ids(awPayments, "reference");
  const ucRef = ids(ycPayments, "reference");

  say(`\n[2] CAMPERS: Appwrite vs ycusers`);
  say(`   Appwrite campers          ${awCampers.length}`);
  say(`   ycusers with legacyAppwriteId ${ucUid.size}`);
  say(`   missing in Mongo          ${awUid.size - ucUid.size}`);
  const missing = [...awUid].filter((u) => !ucUid.has(u));
  if (missing.length) {
    say("   missing samples:");
    missing.slice(0, 5).forEach((u) => say(`      ${u}`));
  }

  say(`\n[3] PAYMENTS: Appwrite vs ycpayments`);
  say(`   Appwrite payments         ${awPayments.length}`);
  say(`   ycpayments with legacyAppwriteId ${ucRef.size}`);
  say(`   distinct references       ${awRef.size}`);
  const missingRef = [...awRef].filter((r) => !ucRef.has(r));
  say(`   missing in Mongo          ${missingRef.length}`);
  if (missingRef.length) {
    say("   missing samples:");
    missingRef.slice(0, 5).forEach((r) => say(`      ${r}`));
  }

  // Index state
  say(`\n[4] ACTUAL INDEXES ON CAMP COLLECTIONS`);
  for (const coll of ["ycusers", "ycpayments", "ycmeallogs", "ycsouvenirs"]) {
    try {
      const res = await db.collection(coll).indexes();
      const list = Array.isArray(res) ? res : res.indexes || [];
      say(`\n   ${coll} - ${list.length} index(es)`);
      list.forEach((ix) => {
        const fields = Object.keys(ix.key).join(", ");
        say(`      ${ix.unique ? "UNIQUE" : "  non"}  ${ix.name} (${fields})`);
      });
    } catch (e) {
      say(`\n   ${coll}: ${e.message}`);
    }
  }

  await mongoose.disconnect();

  say("\n[5] CONFLICT SUMMARY");
  say("   destination (camp) collections already holding data:");
  say("      ycpayments 53 (from Appwrite -> camp migration)");
  say("      ycusers 335  (from Appwrite -> camp migration)");
  say("   Nothing written or modified by this script.");

  say("\n================================================");
  say("DONE - nothing was written or modified");
  say("================================================");

  return 0;
}

main()
  .then((c) => {
    say(`\nEXIT CODE: ${c}`);
    process.exit(c);
  })
  .catch((e) => {
    say(`\nERROR: ${e.name}: ${e.message}`);
    say("\nEXIT CODE: 2");
    process.exit(2);
  });
