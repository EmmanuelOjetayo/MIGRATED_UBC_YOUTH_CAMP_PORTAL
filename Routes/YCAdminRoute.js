// CAMP-Backend/Routes/YCAdminRoute.js
const express = require("express");

const ycAuth = require("../Middleware/YCAuthMiddleware");

const {
  GetCampers,
  GetPayments,
  GetMealLogs,
  GetSouvenirs,
  GetSouvenirCount,
  ScanSouvenir,
  ScanMeal,
  RoleUpdate,
} = require("../Controllers/YCAdminController");

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");
const YCMealLog = require("../Model/YCMealLog");
const YCExpense = require("../Model/YCExpense");

const {
  SendPaymentReminder,
  SendBulkReminders,
} = require("../Controllers/YCReminderController");

const TARGET_FEE = Number(process.env.CAMP_TARGET_FEE) || 5000;

const YCAdminRoute = express.Router();

// ==========================================
// CAMP ADMIN GUARD
// ==========================================
const adminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized.",
    });
  }

  if (req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Admin only.",
    });
  }

  next();
};

// ==========================================
// PAYMENT STATUS / OVERVIEW
// ==========================================

// GET /api/ycadmin/reports/payment-status
YCAdminRoute.get(
  "/reports/payment-status",
  ycAuth,
  adminOnly,
  async (req, res, next) => {
    try {
      const totalCampers = await YCUser.countDocuments();
      const paidCampers = await YCUser.countDocuments({ status: "paid" });
      const pendingCampers = totalCampers - paidCampers;
      const totalTarget = TARGET_FEE;

      const totalPaid = await YCPayment.aggregate([
        { $match: { status: "success" } },
        { $group: { _id: null, sum: { $sum: "$amount" } } },
      ]);

      const targetCollected = totalPaid[0]?.sum || 0;

      res.status(200).json({
        success: true,
        totalCampers,
        paidCampers,
        pendingCampers,
        totalTarget,
        targetCollected,
        remainingTarget: Math.max(totalTarget - targetCollected, 0),
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// DAILY MEAL LOGS
// ==========================================

// GET /api/ycadmin/meal-logs?day=YYYY-MM-DD
YCAdminRoute.get("/meal-logs", ycAuth, adminOnly, GetMealLogs);

// POST /api/ycadmin/meal-logs (migrate legacy meallogs into YCMealLog)
YCAdminRoute.post(
  "/meal-logs",
  ycAuth,
  adminOnly,
  async (req, res, next) => {
    try {
      const { mealLogs } = req.body || {};

      if (!Array.isArray(mealLogs)) {
        const err = new Error("mealLogs array is required");
        err.statusCode = 400;
        throw err;
      }

      const created = [];
      const skipped = [];

      for (const entry of mealLogs) {
        try {
          const { camperId, mealType, day: dayVal, scannedAt } = entry;

          if (!camperId || !mealType || !dayVal) {
            skipped.push({ ...entry, status: "missing_required_fields" });
            continue;
          }

          const log = await YCMealLog.findOneAndUpdate(
            {
              camperId,
              meal_type: mealType,
              day: dayVal,
            },
            {
              camperId,
              meal_type: mealType,
              day: dayVal,
              scanned_at: scannedAt || new Date(),
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );

          created.push(log);
        } catch (err) {
          skipped.push({ ...entry, status: "failed", error: err.message });
        }
      }

      res.status(201).json({
        success: true,
        created: created.length,
        skipped: skipped.length,
        created,
        skipped,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// AGENT-VISIBLE ENDPOINTS
// ==========================================

// List expense reminders (also consumed by YCReminderRoute).
const ListExpenseReminders = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.userId) filter.userId = req.query.userId;
    if (req.query.status) filter.status = req.query.status;
    const reminders = await YCReminderLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.status(200).json({ success: true, count: reminders.length, reminders });
  } catch (error) {
    next(error);
  }
};

// GET /api/ycadmin/expense-reminders
// Spending-paired, admin-review reminders for a camper or all campers.
YCAdminRoute.get(
  "/expense-reminders",
  ycAuth,
  adminOnly,
  ListExpenseReminders
);

// Financial summary (also consumed by YCReminderRoute).
const FinancialSummary = async (req, res, next) => {
  try {
    const { year = String(new Date().getFullYear()), month } = req.query;
    const from = new Date(Number(year), Number(month || 0) - 1, 1);
    const to = new Date(Number(year), Number(month || 12), 1);

    const [campersTotal, campersPaid, campersOutstanding, collected] =
      await Promise.all([
        YCUser.countDocuments(),
        YCUser.countDocuments({ amount_paid: { $gte: TARGET_FEE } }),
        YCUser.countDocuments({ amount_paid: { $lt: TARGET_FEE } }),
        (async () => {
          const res = await YCPayment.aggregate([
            { $match: { status: "success" } },
            { $group: { _id: null, sum: { $sum: "$amount" } } },
          ]);
          return res.length ? res[0].sum : 0;
        })(),
      ]);

    const expenseBreakdown = await YCExpense.aggregate([
      { $match: { date: { $gte: from, $lt: to }, status: "approved" } },
      { $group: { _id: "$category", total: { $sum: "$amount" } } },
    ]);

    const byCategory = expenseBreakdown.map((r) => ({
      category: r._id,
      total: Number(r.total),
    }));

    res.status(200).json({
      success: true,
      year: Number(year),
      month: Number(month || from.getMonth() + 1),
      ranges: { from, to },
      campers: {
        total: campersTotal,
        paid: campersPaid,
        outstanding: campersOutstanding,
      },
      collected,
      expensesByCategory: byCategory,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/ycadmin/reports/financial-summary?year=&month=
// Money in vs money out for the agent's financial_summary tool.
YCAdminRoute.get(
  "/reports/financial-summary",
  ycAuth,
  adminOnly,
  FinancialSummary
);

// ==========================================
// PAYMENT REMINDERS (Brevo) — outstanding/partial only
// ==========================================

YCAdminRoute.post("/payment-reminder", ycAuth, adminOnly, SendPaymentReminder);
YCAdminRoute.post(
  "/payment-reminders/bulk",
  ycAuth,
  adminOnly,
  SendBulkReminders
);

// ==========================================
// CAMPER DATA
// ==========================================

YCAdminRoute.get("/campers", ycAuth, adminOnly, GetCampers);
YCAdminRoute.get("/payments", ycAuth, adminOnly, GetPayments);

// ==========================================
// SOUVENIRS
// ==========================================

YCAdminRoute.get("/souvenirs", ycAuth, adminOnly, GetSouvenirs);
YCAdminRoute.get("/souvenir-logs", ycAuth, adminOnly, GetSouvenirs);
YCAdminRoute.get("/souvenir-count", ycAuth, adminOnly, GetSouvenirCount);
YCAdminRoute.post("/souvenir-scan", ycAuth, adminOnly, ScanSouvenir);

// ==========================================
// OPERATIONS
// ==========================================

YCAdminRoute.post("/meal-scan", ycAuth, adminOnly, ScanMeal);

// ==========================================
// ACCESS CONTROL
// ==========================================

YCAdminRoute.patch(
  "/campers/:id/role",
  ycAuth,
  adminOnly,
  RoleUpdate
);

// PUT alias, kept so both verb conventions work against the CAMP API.
YCAdminRoute.put("/campers/:id/role", ycAuth, adminOnly, RoleUpdate);

// ==========================================
// CAMPER DETAIL STATS
// ==========================================

// GET /api/ycadmin/campers/:id
YCAdminRoute.get(
  "/campers/:id",
  ycAuth,
  adminOnly,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const camper = await YCUser.findById(id).select("-password");

      if (!camper) {
        const err = new Error("Camper not found");
        err.statusCode = 404;
        throw err;
      }

      const [payments, mealLogs, souvenirs] = await Promise.all([
        YCPayment.countDocuments({ camperId: camper._id }),
        YCMealLog.countDocuments({ camperId: camper._id }),
        YCSouvenir.countDocuments({ camperId: camper._id }),
      ]);

      res.status(200).json({
        success: true,
        camper,
        stats: {
          payments,
          mealLogs,
          souvenirs,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = YCAdminRoute;
module.exports.ListExpenseReminders = ListExpenseReminders;
module.exports.FinancialSummary = FinancialSummary;
