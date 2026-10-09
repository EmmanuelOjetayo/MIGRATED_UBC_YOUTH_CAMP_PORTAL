// CAMP-Backend/Routes/YCExpenseRoute.js
// Expense approval + financial summary.
// Consumed by the camp-agent admin tools. The public alias
// /expenses is kept under /api/admin for existing frontend compatibility.
const express = require("express");

// IMPORTANT: copy the SAME import line for ycAuth that YCAdminRoute.js uses.
// If it is exported as an object use:  const { ycAuth } = require(...)
const ycAuth = require("../Middleware/YCAuthMiddleware");

const {
  AddExpense,
  ApproveExpense,
  ListExpenses,
  GetExpenseById,
  GetFinancialSummary,
} = require("../Controllers/YCExpenseController");

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === "admin") return next();
  return res
    .status(403)
    .json({ success: false, message: "Admin access required" });
};

const YCExpenseRoute = express.Router();

// -----------------------------------------
// CAMP AGENT CONSUMPTION (canonical mount)
// -----------------------------------------
// /expenses      admin: list approved expenses (paginated)
// /expenses/:id  admin: single expense
// /summary       admin: monthly financial summary
// -----------------------------------------
// The public alias /expenses is kept under /api/admin so the existing
// CAMP frontend keeps working without a rebuild.

YCExpenseRoute.get("/expenses", ycAuth, adminOnly, ListExpenses);
YCExpenseRoute.get("/expenses/:id", ycAuth, adminOnly, GetExpenseById);
YCExpenseRoute.get("/summary", ycAuth, adminOnly, GetFinancialSummary);

module.exports = YCExpenseRoute;
