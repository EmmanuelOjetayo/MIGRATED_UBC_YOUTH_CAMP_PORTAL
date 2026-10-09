// CAMP-Backend/Controllers/YCExpenseController.js
const YCExpense = require("../Model/YCExpense");
const YCPayment = require("../Model/YCPayment");

const CATEGORIES = ["food", "transport", "accommodation", "equipment", "other"];

// Uses the payment/expense DATE (always present), not the optional `year` field.
const yearRange = (y) => {
  const year = Number(y) || new Date().getFullYear();
  return {
    year,
    from: new Date(Date.UTC(year, 0, 1)),
    to: new Date(Date.UTC(year + 1, 0, 1)),
  };
};

const AddExpense = async (req, res, next) => {
  try {
    const description = String(req.body.description || "").trim();
    const amount = Number(req.body.amount);
    const category = CATEGORIES.includes(req.body.category)
      ? req.body.category
      : "other";

    if (!description) {
      return res
        .status(400)
        .json({ success: false, message: "Description is required" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Amount must be a positive number" });
    }

    const expense = await YCExpense.create({
      description,
      amount,
      category,
      createdBy: req.user._id,
      // Explicit ?approve=false creates a pending expense; default approved
      // keeps the existing admin flow working without an extra click.
      status: req.body?.approve === false ? "pending" : "approved",
      approvedBy: req.body?.approve === false ? null : req.user._id,
    });
    res
      .status(201)
      .json({ success: true, message: "Expense recorded", expense });
  } catch (error) {
    next(error);
  }
};

const ApproveExpense = async (req, res, next) => {
  try {
    const expense = await YCExpense.findById(req.params.id);
    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }
    expense.status = req.body?.approve === false ? "rejected" : "approved";
    expense.approvedBy = req.user._id;
    await expense.save();
    res.status(200).json({ success: true, message: `Expense ${expense.status}`, expense });
  } catch (error) {
    next(error);
  }
};

const ListExpenses = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const filter = {};
    // ?status=pending|approved|rejected — default shows all.
    if (["pending", "approved", "rejected"].includes(req.query.status)) {
      filter.status = req.query.status;
    }
    const expenses = await YCExpense.find(filter)
      .sort({ date: -1 })
      .limit(limit)
      .select("description amount category status date")
      .lean();
    res.status(200).json({ success: true, count: expenses.length, expenses });
  } catch (error) {
    next(error);
  }
};

const GetExpenseById = async (req, res, next) => {
  try {
    const expense = await YCExpense.findById(req.params.id).lean();
    if (!expense) {
      return res
        .status(404)
        .json({ success: false, message: "Expense not found" });
    }
    res.status(200).json({ success: true, expense });
  } catch (error) {
    next(error);
  }
};

const GetFinancialSummary = async (req, res, next) => {
  try {
    const { year, from, to } = yearRange(req.query.year);

    const [pay] = await YCPayment.aggregate([
      { $match: { status: "success", date: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: null,
          net: { $sum: "$amount" },
          gross: { $sum: "$grossAmount" },
          fees: { $sum: "$fees" },
        },
      },
    ]);

    const byCategory = await YCExpense.aggregate([
      { $match: { status: "approved", date: { $gte: from, $lt: to } } },
      { $group: { _id: "$category", total: { $sum: "$amount" } } },
    ]);

    const expensesByCategory = {};
    let totalExpenses = 0;
    for (const row of byCategory) {
      expensesByCategory[row._id] = row.total;
      totalExpenses += row.total;
    }

    // Pending expenses awaiting approval (flagged, never counted in totals).
    const pendingExpenses = await YCExpense.countDocuments({
      status: "pending",
      date: { $gte: from, $lt: to },
    });

    const totalCollected = pay?.net || 0; // net credited to wallets
    const remainingBalance = totalCollected - totalExpenses;
    res.status(200).json({
      success: true,
      year,
      totalCollected,
      grossPaidByCampers: pay?.gross || 0,
      providerFees: pay?.fees || 0,
      totalExpenses,
      remainingBalance,
      expensesByCategory,
      pendingExpenses,
      // Threshold flags: activity near ₦100,000, or balance below ₦100.
      flags: {
        expensesNearThreshold: totalExpenses >= 90000,
        lowBalance: remainingBalance < 100,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { AddExpense, ApproveExpense, ListExpenses, GetExpenseById, GetFinancialSummary };
