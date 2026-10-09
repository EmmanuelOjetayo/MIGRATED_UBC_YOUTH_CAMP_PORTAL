/**
 * READ-ONLY detail on the conflicting `ycpayments` rows and the
 * relationship between `ycampers` and `ycusers`.
 *
 *   node Server/conflict.js
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const LOG = path.join(__dirname, "conflict.log");
const out = [];
const say = (l = "") => {
  out.push(l);
  fs.writeFileSync(LOG, out.join("\n"));
};

async function main() {
  say("================================================");
  say("CONFLICT DETAIL (READ-ONLY, nothing written)");
  say("================================================\n");

  const connectCamp = require("../config/campMongo");
  await connectCamp();
  const db = mongoose.connection.db;

  // ── 1. The 21 pre-existing payment rows ──
  say("[1] ycpayments — PRE-EXISTING ROWS (from GLS migration.js)");

  const pays = await db.collection("ycpayments").find({}).toArray();

  say(`   total rows          : ${pays.length}`);
  say(
    `   rows with transactionId : ${
      pays.filter((p) => p.transactionId).length
    }`
  );
  say(`   rows with legacyAppwriteId : ${pays.filter((p) => p.legacyAppwriteId).length}`);

  const sum = pays.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  say(`   sum of amount       : ₦${sum.toLocaleString()}`);

  const types = [...new Set(pays.map((p) => p.type))];
  say(`   type values         : ${types.join(", ")}`);

  // Do camperIds resolve inside ycampers?
  const camperIds = pays.map((p) => p.camperId);
  const inYcampers = await db
    .collection("ycampers")
    .countDocuments({ _id: { $in: camperIds } });
  const inYcusers = await db
    .collection("ycusers")
    .countDocuments({ _id: { $in: camperIds } });

  say(`   camperIds → ycampers : ${inYcampers}/${pays.length}`);
  say(`   camperIds → ycusers  : ${inYcusers}/${pays.length}`);

  // ── 2. Duplicate references ──
  say("\n[2] DUPLICATE REFERENCES (blocks unique index)");

  const dups = await db
    .collection("ycpayments")
    .aggregate([
      { $match: { reference: { $ne: null } } },
      { $group: { _id: "$reference", n: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  say(`   duplicated reference values : ${dups.length}`);
  say(`   rows involved               : ${dups.reduce((a, d) => a + d.n, 0)}`);

  dups.forEach((d) => {
    say(`      x${d.n}  ${d._id}`);
  });

  // ── 3. ycampers vs ycusers ──
  say("\n[3] CAMPER COLLECTIONS");

  const yc = await db.collection("ycampers").countDocuments();
  const yu = await db.collection("ycusers").countDocuments();

  say(`   ycampers (GLS AuthMiddleware reads this) : ${yc}`);
  say(`   ycusers  (CAMP-Backend's own)            : ${yu}`);

  const withBal = await db
    .collection("ycampers")
    .aggregate([{ $group: { _id: null, sum: { $sum: "$amount_paid" } } }])
    .toArray();

  say(`   ycampers sum(amount_paid)               : ₦${(withBal[0]?.sum || 0).toLocaleString()}`);

  const paidCount = await db
    .collection("ycampers")
    .countDocuments({ amount_paid: { $gte: 5000 } });
  say(`   ycampers already at/above ₦5,000         : ${paidCount}`);

  // ── 4. Is ycampers a GLS runtime dependency? ──
  say("\n[4] WHO READS ycampers?");
  say("   Backend/Middleware/AuthMiddleware.js → ycampers.findById (type=ubcyc)");
  say("   Backend/Model/YMealLogs.js, YPayment.js, YSouvenir.js → ref:\"YCampers\"");
  say("   => ycampers is LIVE and shared; CAMP must not delete or repoint it.");

  await mongoose.disconnect();

  say("\n================================================");
  say("NOTHING WAS WRITTEN OR MODIFIED");
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