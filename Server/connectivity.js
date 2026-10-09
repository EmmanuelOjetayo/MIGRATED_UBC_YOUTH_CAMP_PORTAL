/**
 * CAMP MongoDB connectivity + isolation + index verification.
 *
 * Real connection test:
 *   1. Verify env config (values are NEVER printed)
 *   2. Connect to the SAME MongoDB cluster + database GLS uses
 *   3. Baseline every collection (GLS-owned vs CAMP-owned)
 *   4. Create/verify CAMP indexes (create-only, non-destructive)
 *   5. Re-read to prove GLS collections were not altered
 *
 * Results go to `Server/connectivity.log`.
 *
 *   npm run verify:db
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const LOG = path.join(__dirname, "connectivity.log");
const out = [];

const say = (line = "") => {
  out.push(line);
  fs.writeFileSync(LOG, out.join("\n"));
};

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");
const YCMealLog = require("../Model/YCMealLog");
const YCSouvenir = require("../Model/YCSouvenir");

// CAMP owns exactly these four. Everything else belongs to GLS
// and must be left untouched. NOTE: `ycampers` is a GLS collection
// (registered by Backend/Model/YCampers.js) despite the "yc" prefix.
const CAMP_OWNED = ["ycusers", "ycpayments", "ycmeallogs", "ycsouvenirs"];

const CAMP_MODELS = [
  ["YCUser", YCUser],
  ["YCPayment", YCPayment],
  ["YCMealLog", YCMealLog],
  ["YCSouvenir", YCSouvenir],
];

/** Extracts only the database name — never credentials/host/URI. */
function dbNameFrom(uri) {
  const afterProto = uri.split("://")[1] || "";
  const afterCreds = afterProto.includes("@")
    ? afterProto.split("@").slice(1).join("@")
    : afterProto;
  const dbPart = afterCreds.split("/")[1] || "";
  return dbPart.split("?")[0] || "(default)";
}

async function snapshot(db) {
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const counts = {};

  for (const n of names) {
    counts[n] = await db.collection(n).countDocuments();
  }

  return counts;
}

async function main() {
  say("================================================");
  say("CAMP MONGODB CONNECTIVITY / ISOLATION / INDEXES");
  say("================================================\n");

  // ── STEP 1 — configuration (names only, never values) ──
  say("[1] ENVIRONMENT CONFIG");

  const required = [
    "CAMP_MONGO_URL",
    "CAMP_FLW_SECRET_KEY",
    "CAMP_FLW_SECRET_HASH",
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_DATABASE_ID",
    "APPWRITE_API_KEY",
    "APPWRITE_CAMPERS_COLLECTION",
    "APPWRITE_PAYMENTS_COLLECTION",
    "APPWRITE_MEALLOGS_COLLECTION",
    "APPWRITE_SOUVENIRS_COLLECTION",
  ];

  const missing = required.filter((k) => !process.env[k]);

  required.forEach((k) =>
    say(`   ${missing.includes(k) ? "MISS" : "OK  "} ${k}`)
  );

  if (missing.length) {
    say(`\nBLOCKED — ${missing.length} variable(s) missing.`);
    return 1;
  }

  // Same cluster as GLS (shared infrastructure) but CAMP's own
  // database — compared in memory, values never printed.
  const campUri = process.env.CAMP_MONGO_URL;
  const campDb = process.env.CAMP_MONGO_DB || "(cluster default)";

  const glsPath = path.join(__dirname, "../../Backend/.env");
  const glsUri = fs.existsSync(glsPath)
    ? ((fs.readFileSync(glsPath, "utf8").match(/^MONGO_URL=(.*)$/m) || [])[1] || null)
    : null;

  const sameCluster =
    Boolean(glsUri) && glsUri.split("@")[1] === campUri.split("@")[1];

  say(`\n   CAMP database : ${campDb}`);
  say(`   GLS database  : ${glsUri ? dbNameFrom(glsUri) || "(cluster default)" : "(n/a)"}`);
  say(`   same cluster  : ${sameCluster ? "YES (shared infra)" : "NO"}`);
  say(
    `   same database : ${
      sameCluster && (glsUri ? dbNameFrom(glsUri) || "(cluster default)" : "") === campDb
        ? "YES — NOT ISOLATED"
        : "NO (CAMP isolated)"
    }`
  );

  // ── STEP 2 — real connection via the shared CAMP helper ──
  say("\n[2] CONNECT");

  const connectCamp = require("../config/campMongo");
  const { dbName } = await connectCamp();

  say(`   connected      : YES (readyState=${mongoose.connection.readyState})`);
  say(`   database       : ${dbName}`);

  if (dbName === "test" || dbName === campDb.replace(/^\(.*\)$/, "test")) {
    say("   WARNING        : CAMP is using the cluster default database.");
    say("                    Set CAMP_MONGO_DB in CAMP-Backend/.env.");
  }

  const db = mongoose.connection.db;

  // ── STEP 3 — baseline BEFORE any writes ──
  say("\n[3] COLLECTIONS BEFORE INDEX BUILD");

  const before = await snapshot(db);

  Object.keys(before)
    .sort()
    .forEach((n) => {
      const owner = CAMP_OWNED.includes(n) ? "CAMP" : "GLS ";
      say(`   [${owner}] ${n.padEnd(18)} ${before[n]} doc(s)`);
    });

  say("\n   CAMP model → collection mapping:");
  CAMP_MODELS.forEach(([name, model]) => {
    say(`   ${model.collection.name} ← ${name}`);
  });

  const wrongMapping = CAMP_MODELS.filter(([, m]) => !CAMP_OWNED.includes(m.collection.name));
  say(
    `\n   mapping correct  : ${wrongMapping.length === 0 ? "YES" : "NO — " + wrongMapping.map(([n]) => n).join(", ")}`
  );

  // ── STEP 4 — indexes: create-only, never drops anything ──
  say("\n[4] CAMP INDEX BUILD");

  for (const [name, model] of CAMP_MODELS) {
    try {
      // createIndexes() only ADDS missing indexes; it never drops.
      await model.createIndexes();

      const res = await model.collection.indexes();
      const live = Array.isArray(res) ? res : res.indexes || [];

      say(`\n   ${name} (${model.collection.name}) — ${live.length} index(es)`);

      live.forEach((ix) => {
        const fields = Object.keys(ix.key).join(", ");
        say(
          `      ${ix.unique ? "UNIQUE" : "  non"}  ${ix.name.padEnd(34)} (${fields})`
        );
      });
    } catch (e) {
      say(`\n   FAIL ${name}: ${e.message}`);
    }
  }

  // ── STEP 5 — idempotency of the index build ──
  say("\n[5] INDEX BUILD RE-RUN (must be a no-op, non-destructive)");

  for (const [name, model] of CAMP_MODELS) {
    try {
      const readIndexes = async () => {
        const res = await model.collection.indexes();
        const list = Array.isArray(res) ? res : res.indexes || [];
        return list.map((i) => i.name).sort();
      };

      const first = await readIndexes();
      await model.createIndexes();
      const second = await readIndexes();

      const same = JSON.stringify(first) === JSON.stringify(second);

      say(
        `   ${same ? "OK  " : "FAIL"} ${name}: ${first.length} → ${second.length} index(es)`
      );

      if (!same) {
        const added = second.filter((n) => !first.includes(n));
        if (added.length) say(`         added: ${added.join(", ")}`);
      }
    } catch (e) {
      say(`   FAIL ${name}: ${e.message}`);
    }
  }

  // ── STEP 6 — GLS collections unchanged ──
  say("\n[6] GLS COLLECTIONS AFTER CAMP INDEX BUILD");

  const after = await snapshot(db);

  const glsNames = Object.keys(before).filter(
    (n) => !CAMP_OWNED.includes(n)
  );

  let glsChanged = 0;

  glsNames.forEach((n) => {
    const b = before[n];
    const a = after[n];
    const ok = b === a;
    if (!ok) glsChanged++;
    say(`   ${ok ? "OK  " : "FAIL"} ${n.padEnd(18)} ${b} → ${a} doc(s)`);
  });

  say(
    `\n   GLS collections unchanged : ${
      glsChanged === 0 ? "YES (0 changed)" : `NO (${glsChanged} changed)`
    }`
  );

  const newCollections = Object.keys(after).filter((n) => !before[n] && before[n] !== 0);

  say(
    `   new collections created   : ${
      newCollections.length ? newCollections.join(", ") : "(none)"
    }`
  );

  const illegalNew = newCollections.filter((n) => !CAMP_OWNED.includes(n));

  say(
    `   all new collections are CAMP-owned : ${
      illegalNew.length === 0 ? "YES" : "NO — " + illegalNew.join(", ")
    }`
  );

  await mongoose.disconnect();
  say("\n   connection closed.");

  say("\n================================================");
  say("DONE — review PASS/FAIL above");
  say("================================================");

  return 0;
}

main()
  .then((code) => {
    say(`\nEXIT CODE: ${code}`);
    process.exit(code);
  })
  .catch((err) => {
    say(`\nERROR: ${err.name}: ${err.message}`);
    if (err.code) say(`ERROR CODE: ${err.code}`);
    say("\nCONNECTION FAILED — see message above.");
    say("\nEXIT CODE: 2");
    process.exit(2);
  });