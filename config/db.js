const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({
  path: path.join(__dirname, "../.env"),
});

// ─────────────────────────────────────────────────────────────
// CAMP MongoDB connection.
//
// CAMP intentionally reuses the SAME MongoDB deployment as the
// GLS backend (`Backend/`), but writes only to CAMP-owned
// collections (`ycusers`, `ycpayments`, `ycmeallogs`, `ycsouvenirs`).
// GLS collections are never read or written from this backend.
// ─────────────────────────────────────────────────────────────

const CAMP_MONGO_URL = process.env.CAMP_MONGO_URL;

// CAMP's own database on the shared cluster. GLS stays in the
// cluster's default database, so collections can never collide.
const CAMP_MONGO_DB = process.env.CAMP_MONGO_DB;

async function DB_Connect() {
  if (!CAMP_MONGO_URL) {
    throw new Error("CAMP_MONGO_URL is not set in CAMP-Backend/.env");
  }

  const options = CAMP_MONGO_DB ? { dbName: CAMP_MONGO_DB } : {};

  const conn = await mongoose.connect(CAMP_MONGO_URL, options);
  console.log(
    `CAMP Database connected: "${conn.connection.db.databaseName}"`
  );
  return conn;
}

module.exports = DB_Connect;
