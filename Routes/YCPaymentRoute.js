const express = require("express");

const {
  initiatePayment,
  verifyPayment,
  recoverPayment,
  flutterwaveWebhook,
} = require("../Controllers/YCPaymentController");

const {
  resolveReceiver,
  transferGiveaway,
} = require("../Controllers/YCGiveawayController");

const ycAuth = require("../Middleware/YCAuthMiddleware");

const YCPaymentRoute = express.Router();

// ==========================================
// CAMP PAYMENT
// ==========================================

// Server-side reference generation
YCPaymentRoute.post("/initiate", ycAuth, initiatePayment);

// Flutterwave callback from the frontend
YCPaymentRoute.post("/verify", ycAuth, verifyPayment);

// Fallback/recovery: re-runs verification when the primary attempt
// hit a transient error (safe to retry — idempotent).
YCPaymentRoute.post("/recovery", ycAuth, recoverPayment);

// Flutterwave server-to-server webhook.
// Authenticated by the `verif-hash` secret, NOT by a user JWT —
// Flutterwave does not hold a CAMP account token.
YCPaymentRoute.post("/webhook", flutterwaveWebhook);

// ==========================================
// CAMP GIVEAWAY
// ==========================================

YCPaymentRoute.post("/giveaway/resolve", ycAuth, resolveReceiver);
YCPaymentRoute.post("/giveaway/transfer", ycAuth, transferGiveaway);

module.exports = YCPaymentRoute;