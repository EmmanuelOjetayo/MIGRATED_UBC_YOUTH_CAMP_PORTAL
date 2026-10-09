const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// CAMP SOUVENIR (YCSouvenir)
//
// Migrated from the legacy Appwrite `souvenirs` collection.
//
// A camper may collect exactly ONE souvenir. The unique index on
// `camperId` turns that into a database-level guarantee.
// ─────────────────────────────────────────────────────────────

const YCSouvenirSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      default: "ubcyc",
    },

    camperId: {
      ref: "YCUser",
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },

    camperName: String,

    collected_at: {
      type: Date,
      default: Date.now,
    },

    phone: String,

    level: String,

    legacyAppwriteId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("YCSouvenir", YCSouvenirSchema);