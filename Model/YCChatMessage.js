// CAMP-Backend/Model/YCChatMessage.js
// Persists EVERY user <-> AI-agent message so the agent can use previous
// conversations as context and so daily usage can be counted per user.
const mongoose = require("mongoose");

const YCChatMessageSchema = new mongoose.Schema(
  {
    // Logged-in camper/admin who sent or received the message.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "YCUser",
      default: null,
      index: true,
    },

    // Anonymous visitors are scoped by an IP-derived id so their
    // history still follows them between messages (never by JWT).
    guestId: { type: String, default: null, index: true },

    role: { type: String, enum: ["user", "assistant"], required: true },

    content: { type: String, required: true, trim: true, maxlength: 4000 },

    // Used for the "10 messages per user per day" window.
    date: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

YCChatMessageSchema.index({ userId: 1, role: 1, date: -1 });

module.exports =
  mongoose.models.YCChatMessage ||
  mongoose.model("YCChatMessage", YCChatMessageSchema);
