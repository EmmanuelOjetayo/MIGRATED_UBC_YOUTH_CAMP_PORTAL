// CAMP-Backend/Model/YCYearlySummary.js
// Year-end aggregate snapshot. Detail rows may be archived after a
// camp cycle, but these totals must be retained.
const mongoose = require("mongoose");

const YCYearlySummarySchema = new mongoose.Schema(
  {
    year: { type: Number, required: true, unique: true, index: true },
    totalCampers: { type: Number, default: 0 },
    totalCollected: { type: Number, default: 0 },
    totalExpenses: { type: Number, default: 0 },
    totalOutstanding: { type: Number, default: 0 },
    completedPayments: { type: Number, default: 0 },
    partialPayments: { type: Number, default: 0 },
    unpaidCampers: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.YCYearlySummary ||
  mongoose.model("YCYearlySummary", YCYearlySummarySchema);
