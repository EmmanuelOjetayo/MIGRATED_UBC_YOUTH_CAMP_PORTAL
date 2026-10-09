// CAMP-Backend/Controllers/YCReminderController.js
// Payment-reminder emails (Brevo) — triggered by the admin UI or by
// the AI agent when an admin explicitly instructs it.
//
// SAFETY RULE (enforced here, not in the AI): only campers with an
// outstanding balance (partial OR unpaid) can ever receive a reminder.
// Fully-paid campers are rejected with 400 before any email is built.
const YCUser = require("../Model/YCUser");
const { sendPaymentReminderMail } = require("../utils/sendYCMail");

const TARGET_FEE = Number(process.env.CAMP_TARGET_FEE) || 5000;

const balanceOf = (camper) =>
  Math.max(TARGET_FEE - Number(camper.amount_paid || 0), 0);

// ─────────────────────────────────────────────────────────────
// POST /api/ycadmin/payment-reminder   { camperId, note? }
// ─────────────────────────────────────────────────────────────

const SendPaymentReminder = async (req, res, next) => {
  try {
    const camperId = String(req.body?.camperId || "").trim();
    const note = String(req.body?.note || "").trim().slice(0, 300);

    if (!camperId) {
      return res
        .status(400)
        .json({ success: false, message: "camperId is required" });
    }

    const camper = await YCUser.findById(camperId);
    if (!camper) {
      return res
        .status(404)
        .json({ success: false, message: "Camper not found" });
    }

    const balance = balanceOf(camper);
    if (balance <= 0 || camper.status === "paid") {
      return res.status(400).json({
        success: false,
        message: `${camper.name || "This camper"} has no outstanding balance — reminder not sent.`,
      });
    }

    const ok = await sendPaymentReminderMail({
      email: camper.email,
      name: camper.name,
      amountPaid: Number(camper.amount_paid || 0),
      balance,
      target: TARGET_FEE,
      note,
    });

    if (!ok) {
      return res.status(502).json({
        success: false,
        message: "The email service could not deliver this reminder. Please try again.",
      });
    }

    console.log(
      `[YC REMINDER] Sent to ${camper.email} | balance ₦${balance} | by ${req.user?.email}`
    );

    res.status(200).json({
      success: true,
      message: `Reminder sent to ${camper.name || camper.email}`,
      sentTo: camper.email,
      balance,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/ycadmin/payment-reminders/bulk
// Targets ONLY campers with balance > 0 and status !== "paid".
// ─────────────────────────────────────────────────────────────

const SendBulkReminders = async (req, res, next) => {
  try {
    const candidates = await YCUser.find({
      email: { $exists: true, $ne: null },
    }).select("name email amount_paid status role");

    const eligible = candidates.filter(
      (c) => balanceOf(c) > 0 && c.status !== "paid"
    );

    let sent = 0;
    let failed = 0;

    for (const camper of eligible) {
      const ok = await sendPaymentReminderMail({
        email: camper.email,
        name: camper.name,
        amountPaid: Number(camper.amount_paid || 0),
        balance: balanceOf(camper),
        target: TARGET_FEE,
        note: String(req.body?.note || "").trim().slice(0, 300),
      });
      if (ok) sent += 1;
      else failed += 1;
    }

    console.log(
      `[YC REMINDER BULK] by ${req.user?.email} | eligible ${eligible.length} | sent ${sent} | failed ${failed}`
    );

    res.status(200).json({
      success: true,
      eligible: eligible.length,
      sent,
      failed,
      skippedPaid: candidates.length - eligible.length,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { SendPaymentReminder, SendBulkReminders };
