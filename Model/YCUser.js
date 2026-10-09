const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// CAMP CAMPER (YCUser)
//
// Migrated from the legacy Appwrite `campers` collection and
// previously modelled as `ycampers` inside the GLS backend.
// CAMP owns its own `ycusers` collection so CAMP records can never
// be confused with, or written into, GLS `users` / `ycampers`.
//
// NOTE: passwords are NOT migrated from Appwrite (they are hashed by
// Appwrite and cannot be reversed). Legacy campers must use the
// CAMP forgot-password flow to set a new password.
// ─────────────────────────────────────────────────────────────

const YCUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    role: {
      type: String,
      default: "user",
      enum: ["user", "admin"],
    },

    type: {
      type: String,
      default: "ubcyc",
    },

    name: String,

    phone: String,

    gender: String,

    password: String,

    amount_paid: {
      type: Number,
      default: 0,
    },

    status: {
      type: String,
      default: "pending",
    },

    // ── CAMP LOGISTICS ──
    team: { type: String, default: null },
    bus_no: { type: String, default: null },
    bed_no: { type: String, default: null },

    // ── PASSWORD RESET (token-link flow) ──
    resetPasswordToken: {
      type: String,
      default: null,
    },

    resetPasswordExpires: {
      type: Date,
      default: null,
    },

    // ── LEGACY TRACEABILITY ──
    // Original Appwrite document id, kept so migrated records can
    // be reconciled back against the legacy Appwrite project.
    legacyAppwriteId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("YCUser", YCUserSchema);