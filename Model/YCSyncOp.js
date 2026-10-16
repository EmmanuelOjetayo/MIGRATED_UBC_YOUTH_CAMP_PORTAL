const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// CAMP SYNC OP (YCSyncOp)
//
// Audit + idempotency ledger for operations that arrive from the
// OFFLINE admin app. This is ADDITIVE: it does not change any
// existing collection or contract.
//
// `opId` is uniquely indexed, so replaying the same offline
// operation (same admin, same scan) can never be applied twice,
// even under concurrent retries from several devices.
//
// `dedupeKey` mirrors the business rules (one Breakfast/camper/day,
// one souvenir/camper) so two DIFFERENT devices recording the same
// event still collapse to one authoritative record.
// ─────────────────────────────────────────────────────────────

const YCSyncOpSchema = new mongoose.Schema(
  {
    opId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    type: {
      type: String,
      required: true,
      // meal_scan | souvenir_scan | role_update
    },

    // Business-level uniqueness key (nullable for role updates).
    dedupeKey: {
      type: String,
      default: null,
      index: true,
    },

    camperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
      index: true,
    },

    // Which administrator device created the operation.
    deviceId: { type: String, default: null },

    // Which administrator (YCUser id) performed it.
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
    },

    // Client-side creation time (may be offline).
    clientCreatedAt: { type: Date, default: null },

    // The resulting authoritative record id (meal log / souvenir / user).
    resultId: { type: String, default: null },

    status: {
      type: String,
      default: "applied",
      // applied | duplicate | rejected
    },

    reason: { type: String, default: null },

    // Raw payload as submitted, for audit.
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("YCSyncOp", YCSyncOpSchema);
