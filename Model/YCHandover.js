// CAMP-Backend/Model/YCHandover.js
// Human-handover queue: questions the AI could not answer confidently.
// Admins resolve them; resolutions can become FAQ entries.
const mongoose = require("mongoose");

const YCHandoverSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
      index: true,
    },
    guestId: { type: String, default: null, index: true },
    camperName: { type: String, default: "" },
    question: { type: String, required: true, trim: true, maxlength: 2000 },
    answer: { type: String, default: "", trim: true, maxlength: 2000 },
    status: {
      type: String,
      enum: ["pending", "resolved"],
      default: "pending",
      index: true,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
    },
    resolvedAt: { type: Date, default: null },
    promotedToFaq: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.YCHandover || mongoose.model("YCHandover", YCHandoverSchema);
