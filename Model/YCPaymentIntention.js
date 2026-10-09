// CAMP-Backend/Model/YCPaymentIntention.js
// A camper's stated plan for completing a partial payment
// (e.g. "I will pay Friday"). The agent saves it; reminders and
// follow-up chats reuse it for personal context.
const mongoose = require("mongoose");

const YCPaymentIntentionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      required: true,
      index: true,
    },
    note: { type: String, required: true, trim: true, maxlength: 300 },
    intendToPayAt: { type: String, default: "" },
    createdBy: { type: String, enum: ["camper", "admin", "agent"], default: "agent" },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.YCPaymentIntention ||
  mongoose.model("YCPaymentIntention", YCPaymentIntentionSchema);
