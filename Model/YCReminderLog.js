// CAMP-Backend/Model/YCReminderLog.js
// Audit trail of every payment-reminder email (single + bulk).
const mongoose = require("mongoose");

const YCReminderLogSchema = new mongoose.Schema(
  {
    camperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
      index: true,
    },
    email: { type: String, default: "" },
    balance: { type: Number, default: 0 },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
    },
    bulk: { type: Boolean, default: false },
    delivered: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.YCReminderLog ||
  mongoose.model("YCReminderLog", YCReminderLogSchema);
