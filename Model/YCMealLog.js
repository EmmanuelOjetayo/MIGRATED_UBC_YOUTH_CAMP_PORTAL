const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// CAMP MEAL LOG (YCMealLog)
//
// Migrated from the legacy Appwrite `meallogs` collection.
//
// A camper may only be served ONE of each meal per day.
// The compound unique index makes that rule a database guarantee,
// so a double QR scan can never create two meal logs.
// ─────────────────────────────────────────────────────────────

const YCMealLogSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      default: "ubcyc",
    },

    meal_type: {
      type: String,
      enum: ["Breakfast", "Lunch", "Dinner"],
      required: true,
    },

    scanned_at: {
      type: Date,
      default: Date.now,
    },

    meal_id: String,

    camperId: {
      ref: "YCUser",
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    // ISO date string, e.g. "2026-01-14"
    day: {
      type: String,
      required: true,
    },

    legacyAppwriteId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

YCMealLogSchema.index({ camperId: 1, meal_type: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("YCMealLog", YCMealLogSchema);