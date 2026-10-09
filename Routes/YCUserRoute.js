const express = require("express");

const {
  SignUp,
  Login,
  FetchYCUserData,
  ForgotPassword,
  ResetPassword,
} = require("../Controllers/YCAuthController");

const ycAuth = require("../Middleware/YCAuthMiddleware");

const {
  SaveIntention,
  LatestIntention,
} = require("../Controllers/YCIntentionController");

const YCUserRoute = express.Router();

// ==========================================
// PUBLIC ROUTES
// ==========================================

YCUserRoute.post("/signup", SignUp);
YCUserRoute.post("/login", Login);

// ==========================================
// PASSWORD RESET (token-link flow)
// ==========================================

YCUserRoute.post("/forgot-password", ForgotPassword);
YCUserRoute.post("/reset-password/:token", ResetPassword);

// ==========================================
// AUTHENTICATED ROUTES
// ==========================================

YCUserRoute.get("/me", ycAuth, FetchYCUserData);

// Stated payment plan ("I will pay Friday") — agent + camper share this.
YCUserRoute.post("/intention", ycAuth, SaveIntention);
YCUserRoute.get("/intention", ycAuth, LatestIntention);

module.exports = YCUserRoute;