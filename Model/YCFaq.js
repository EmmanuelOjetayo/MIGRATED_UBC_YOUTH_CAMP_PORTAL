// CAMP-Backend/Model/YCFaq.js
// Admin-managed knowledge base. The camp-agent fetches active entries
// from `GET /api/faq` on every turn, so edits here reach the AI
// immediately — no agent restart or file copy required.
const mongoose = require("mongoose");

const YCFaqSchema = new mongoose.Schema(
  {
    question: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    answer: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    // Hidden entries stay in the DB but are excluded from the agent's context.
    active: { type: Boolean, default: true, index: true },
    category: { type: String, default: "general", trim: true, maxlength: 60 },
    sortOrder: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.YCFaq || mongoose.model("YCFaq", YCFaqSchema);
