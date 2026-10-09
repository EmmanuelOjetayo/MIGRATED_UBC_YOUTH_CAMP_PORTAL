// CAMP-Backend/Routes/YCReminderRoute.js
// Expense-linked reminders — admin review + agent consumption.
// Canonical mount: /api/ycadmin/reminders
//   GET     /             list all expense reminders
//   GET     /:userId      list a camper's reminders
//   GET     /financial-summary  agent-readable financial summary (dated)
const express = require("express");

const ycAuth = require("../Middleware/YCAuthMiddleware");

const {
  ListExpenseReminders,
  FinancialSummary,
} = require("../Routes/YCAdminRoute");

const YCReminderRoute = express.Router();

// Expense-linked reminders — admin review + agent consumption.
YCReminderRoute.get("/", ycAuth, ListExpenseReminders);
YCReminderRoute.get("/:userId", ycAuth, ListExpenseReminders);

// Agent-readable financial summary (dated).
YCReminderRoute.get("/financial-summary", ycAuth, FinancialSummary);

module.exports = YCReminderRoute;
