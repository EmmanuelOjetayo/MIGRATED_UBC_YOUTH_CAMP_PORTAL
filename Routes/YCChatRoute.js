// CAMP-Backend/Routes/YCChatRoute.js
const express = require("express");

const ycAuth = require("../Middleware/YCAuthMiddleware");

const {
  LogChatMessage,
  GetChatContext,
  GetChatHistory,
  GetUserChat,
} = require("../Controllers/YCChatController");

const {
  CreateHandover,
  ListHandovers,
  ResolveHandover,
} = require("../Controllers/YCHandoverController");

const YCChatRoute = express.Router();

// Auth ONLY when the caller sends a token (guests chat anonymously).
const maybeAuth = (req, res, next) =>
  req.headers.authorization ? ycAuth(req, res, next) : next();

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === "admin") return next();
  return res
    .status(req.user ? 403 : 401)
    .json({ success: false, message: "Admin access required" });
};

// Persist + quota-check one message (agent calls this per turn).
YCChatRoute.post("/log", maybeAuth, LogChatMessage);

// Prior conversation for personalisation (agent calls this per turn).
YCChatRoute.get("/context", maybeAuth, GetChatContext);

// Own history / admin viewing a camper's history.
YCChatRoute.get("/history", ycAuth, GetChatHistory);
YCChatRoute.get("/user/:userId", ycAuth, adminOnly, GetUserChat);

// Human handover: anyone can file; only admins list/resolve.
YCChatRoute.post("/handover", maybeAuth, CreateHandover);
YCChatRoute.get("/handovers", ycAuth, adminOnly, ListHandovers);
YCChatRoute.post("/handovers/:id/resolve", ycAuth, adminOnly, ResolveHandover);

module.exports = YCChatRoute;
