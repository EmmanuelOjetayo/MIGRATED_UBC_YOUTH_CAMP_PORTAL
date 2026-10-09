const path = require("path");
const dns = require("dns");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const mongoose = require("mongoose");

// Same DNS configuration the GLS backend applies in Server/app.js:
// Atlas uses SRV lookup, which the default resolver can fail to answer.
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

/**
 * Single source of truth for how CAMP reaches MongoDB.
 *
 * SAME cluster/URI as the GLS backend (shared infrastructure), but a
 * DISTINCT database name (`CAMP_MONGO_DB`), so CAMP collections such as
 * `ycusers` / `ycpayments` can never collide with the collections GLS
 * already owns in its own database.
 *
 * Every CAMP script — runtime, migration and verification — must
 * connect through this helper so they all read and write the same place.
 */
async function connectCamp() {
  const uri = process.env.CAMP_MONGO_URL;
  const dbName = process.env.CAMP_MONGO_DB;

  if (!uri) {
    throw new Error("CAMP_MONGO_URL is not set in CAMP-Backend/.env");
  }

  const options = dbName ? { dbName } : {};

  const conn = await mongoose.connect(uri, options);

  return {
    conn,
    dbName: conn.connection.db.databaseName,
    async disconnect() {
      await mongoose.disconnect();
    },
  };
}

module.exports = connectCamp;
module.exports.connectCamp = connectCamp;