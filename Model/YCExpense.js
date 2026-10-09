// CAMP-Backend/Model/YCExpense.js
const mongoose = require("mongoose");

const YCExpenseSchema = new mongoose.Schema(
  {
    type: { type: String, default: "ubcyc" },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    amount: { type: Number, required: true, min: 1 },
    category: {
      type: String,
      enum: ["food", "transport", "accommodation", "equipment", "other"],
      default: "other",
      index: true,
    },
    date: { type: Date, default: Date.now, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "YCUser" },
    // Approval workflow: admins approve before an expense counts.
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "approved",
      index: true,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.YCExpense || mongoose.model("YCExpense", YCExpenseSchema);
