const mongoose = require("mongoose");
const YCUser = require("./YCUser");

// ─────────────────────────────────────────────────────────────
// CAMP PAYMENT (YCPayment)
//
// Migrated from the legacy Appwrite `payments` collection and
// previously modelled as `ypayments` inside the GLS backend.
//
// IDEMPOTENCY is enforced at the DATABASE level, not only in
// application code: `transactionId` and `reference` are both
// uniquely indexed. A repeated Flutterwave webhook therefore
// cannot credit a CAMP camper twice even under concurrency.
// ─────────────────────────────────────────────────────────────

const YCPaymentSchema = new mongoose.Schema(
  {
    camperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      required: true,
      index: true,
    },

    type: {
      type: String,
      default: "ubcyc",
    },

    // ── IDEMPOTENCY KEYS ──
    // Flutterwave transaction id: the authoritative unique key for every
    // NEW payment. Sparse, so legacy rows migrated from Appwrite (which
    // have no transaction id) coexist without blocking the index.
    transactionId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    // Our own merchant reference, e.g. `YC-<camperId>-<timestamp>`.
    // Indexed by the partial-unique `reference_1_camp` below — no plain
    // index is declared here so the field is indexed exactly once.
    reference: {
      type: String,
    },

    // ── MONEY ──
    amount: {
      type: Number,
      default: 0,
    },

    // Full gross amount and provider fee, kept for reconciliation.
    grossAmount: Number,
    fees: Number,

    currency: {
      type: String,
      default: "NGN",
    },

    // ── PAYMENT LIFECYCLE ──
    // success | failed | transfer_in | transfer_out
    status: {
      type: String,
      default: "success",
    },

    channel: String,

    date: {
      type: Date,
      default: Date.now,
    },

    year: Number,

    // Legacy Appwrite payment document id (traceability).
    legacyAppwriteId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ─────────────────────────────────────────────────────────────
// IDEMPOTENCY INDEXES
//
// `transactionId` (declared on the field above) is sparse + unique, so
// every Flutterwave transaction can only ever produce ONE payment, while
// legacy Appwrite rows — which have no transaction id — remain valid.
//
// `reference` is UNIQUE for CAMP payments only (those carrying a
// transaction id). The legacy Appwrite export contains duplicate
// reference values, so a blanket unique index would reject valid
// migrated history; this partial index enforces uniqueness exactly
// where it is actually guaranteed.
// ─────────────────────────────────────────────────────────────

YCPaymentSchema.index(
  { reference: 1 },
  {
    unique: true,
    name: "reference_1_camp",
    partialFilterExpression: { transactionId: { $type: "string" } },
  }
);

module.exports = mongoose.model("YCPayment", YCPaymentSchema);