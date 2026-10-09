// CAMP-Backend/Routes/YCFaqRoute.js
// Mounted once at `/api/faq`:
//   GET    /api/faq          → public (agent + site) — active entries
//   GET    /api/faq/manage   → admin — all entries
//   POST   /api/faq          → admin — create
//   PUT    /api/faq/:id      → admin — edit
//   DELETE /api/faq/:id      → admin — delete
const express = require("express");

const ycAuth = require("../Middleware/YCAuthMiddleware");

const {
  GetFaqs,
  ListFaqs,
  CreateFaq,
  UpdateFaq,
  DeleteFaq,
} = require("../Controllers/YCFaqController");

const YCFaqRoute = express.Router();

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === "admin") return next();
  return res
    .status(req.user ? 403 : 401)
    .json({ success: false, message: "Admin access required" });
};

YCFaqRoute.get("/", GetFaqs);
YCFaqRoute.get("/manage", ycAuth, adminOnly, ListFaqs);
YCFaqRoute.post("/", ycAuth, adminOnly, CreateFaq);
YCFaqRoute.put("/:id", ycAuth, adminOnly, UpdateFaq);
YCFaqRoute.delete("/:id", ycAuth, adminOnly, DeleteFaq);

module.exports = YCFaqRoute;
