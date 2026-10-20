// ─────────────────────────────────────────────────────────────
// CAMP central email utility — Brevo Transactional API.
// All CAMP email sending must go through this file.
// Independent of the GLS `Backend/utils/sendMail.js`.
// ─────────────────────────────────────────────────────────────

const { BrevoClient } = require("@getbrevo/brevo");

require("dotenv").config({
  path: require("path").join(__dirname, "../.env"),
});

const brevo = new BrevoClient({
  apiKey: process.env.CAMP_EMAIL_PASS,
});

const SENDER = {
  name: process.env.CAMP_EMAIL_SENDER_NAME || "UBC Youth Camp",
  email: process.env.CAMP_EMAIL_USER,
};

const BRAND = "#722F37";
const GOLD = "#D4AF37";

// ─────────────────────────────────────────────────────────────
// Core low-level send function
// ─────────────────────────────────────────────────────────────

const sendMail = async ({ to, name, subject, htmlContent }) => {
  try {
    await brevo.transactionalEmails.sendTransacEmail({
      sender: SENDER,
      to: [{ email: to, name: name || "Camper" }],
      subject,
      htmlContent,
    });

    return true;
  } catch (error) {
    console.error("[CAMP sendMail] Brevo send error:", error?.message || error);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────
// Shared branded layout
// ─────────────────────────────────────────────────────────────

const layout = ({ kicker, heading, name, bodyHtml }) => `
  <div style="font-family: Arial, Helvetica, sans-serif; margin:0; padding:0; background:#f5f3f3;">
    <div style="max-width:600px; margin:40px auto; background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 10px 40px rgba(114,47,55,0.12);">

      <div style="background:${BRAND}; padding:35px 20px; text-align:center;">
        <h1 style="margin:0; color:#ffffff; font-size:24px; font-weight:800;">UBC YOUTH CAMP</h1>
        <p style="margin:8px 0 0; color:${GOLD}; font-size:11px; font-weight:bold; letter-spacing:2px;">${kicker}</p>
      </div>

      <div style="padding:40px 30px;">
        <h2 style="color:${BRAND}; margin-top:0; font-size:22px;">${heading}</h2>
        <p style="color:#555555; font-size:15px; line-height:1.7;">Hello ${name || "there"},</p>
        ${bodyHtml}
      </div>

      <div style="background:#f8f6f6; padding:25px; text-align:center;">
        <p style="margin:0; color:${BRAND}; font-size:13px; font-weight:bold;">UBC Youth Camp</p>
        <p style="margin:6px 0 0; color:#999999; font-size:11px;">Youth Camp Portal ${new Date().getFullYear()}</p>
      </div>

    </div>
  </div>
`;

const noteBox = (html) => `
  <div style="background:#fff8e1; border-left:4px solid ${GOLD}; padding:16px 18px; border-radius:8px; margin:24px 0;">
    <p style="margin:0; color:#665533; font-size:14px; line-height:1.7;">${html}</p>
  </div>
`;

const resetButton = (resetLink, label) => `
  <div style="text-align:center; margin:30px 0;">
    <a href="${resetLink}" style="display:inline-block; background:${BRAND}; color:#ffffff; padding:15px 32px; border-radius:10px; text-decoration:none; font-size:14px; font-weight:bold;">${label}</a>
  </div>
`;

// ─────────────────────────────────────────────────────────────
// CAMP: standard password reset link
// ─────────────────────────────────────────────────────────────

const sendResetPasswordMail = async ({ email, name, resetLink }) => {
  const htmlContent = layout({
    kicker: "PASSWORD RESET",
    heading: "Reset your password",
    name,
    bodyHtml: `
      <p style="color:#555555; font-size:15px; line-height:1.7;">
        We received a request to reset the password for your UBC Youth Camp account.
        Click the button below to create a new password.
      </p>
      ${resetButton(resetLink, "RESET MY PASSWORD")}
      ${noteBox("This password reset link will expire in <strong>15 minutes</strong>.")}
      <p style="color:#777777; font-size:13px; line-height:1.6;">
        If you did not request this password reset, you can safely ignore this email.
      </p>
    `,
  });

  return sendMail({
    to: email,
    name,
    subject: "Reset Your UBC Youth Camp Password",
    htmlContent,
  });
};

// ─────────────────────────────────────────────────────────────
// CAMP: infrastructure-migration notice
//
// Sent to campers migrated from the legacy Appwrite system, whose
// Appwrite password hashes could not be transferred.
// ─────────────────────────────────────────────────────────────

const sendMigrationNoticeMail = async ({ email, name, resetLink }) => {
  const htmlContent = layout({
    kicker: "INFRASTRUCTURE UPGRADE",
    heading: "We have upgraded our platform",
    name,
    bodyHtml: `
      <p style="color:#555555; font-size:15px; line-height:1.7;">
        We have migrated from our previous Appwrite system to a new, more secure platform.
        <strong>All of your camp data — payments, team, bus and bed assignments — has been carried over.</strong>
      </p>
      ${noteBox(
        "<strong>Action required:</strong> for security and infrastructure reasons, your previous password could not be transferred to the new platform. Please create a new password to continue using your account."
      )}
      ${resetButton(resetLink, "CREATE MY NEW PASSWORD")}
      <p style="color:#777777; font-size:13px; line-height:1.6;">
        This link expires in <strong>15 minutes</strong>. Your camp fee balance and logistics
        assignments are untouched and remain exactly as they were.
      </p>
    `,
  });

  return sendMail({
    to: email,
    name,
    subject: "UBC Youth Camp — Please create a new password",
    htmlContent,
  });
};

// ─────────────────────────────────────────────────────────────
// CAMP: payment reminder (partial / outstanding balances)
//
// Tone is deliberately respectful: no shaming, no pressure —
// progress, remaining balance, and an easy way to pay.
// ─────────────────────────────────────────────────────────────

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const sendPaymentReminderMail = async ({
  email,
  name,
  amountPaid = 0,
  balance = 0,
  target = 5000,
  note = "",
}) => {
  const safeName = escapeHtml(name);
  const paid = Number(amountPaid) || 0;
  const owed = Number(balance) || 0;
  const goal = Number(target) || 5000;
  const pct = Math.min(Math.round((paid / goal) * 100), 100);
  const naira = (n) => `₦${Number(n).toLocaleString("en-NG")}`;
  const portal =
    process.env.CAMP_FRONTEND_URL || "http://localhost:5173";


const htmlContent = layout({
  kicker: "🚨 URGENT PAYMENT ALERT",
  heading: "LESS THAN 50 HOURS TO CAMP!",
  name: safeName,
  bodyHtml: `
    <div style="background:#fff1f1; border:1px solid #f2c4c4;
                border-radius:12px; padding:18px; margin-bottom:20px;">
      <p style="color:#b42318; font-size:16px; font-weight:900;
                line-height:1.6; text-align:center; margin:0 0 10px;">
        🚨 ATTENTION, CAMPERS! THE COUNTDOWN IS ON! 🚨
      </p>
      <p style="color:#7a1f1f; font-size:15px; line-height:1.7;
                text-align:center; margin:0;">
        <strong>UBC YOUTH CAMP: THE REIGN 2026</strong> IS JUST
        AROUND THE CORNER, WITH LESS THAN 50 HOURS TO GO!
        THE DEADLINE IS FAST APPROACHING, AND NOW IS THE TIME TO ACT.
      </p>
    </div>

    <p style="color:#555555; font-size:15px; line-height:1.7;">
      Dear <strong>${escapeHtml(safeName)}</strong>, we need your urgent
      attention to your camp payment. Please check your outstanding balance
      below and make arrangements to complete your payment as soon as possible.
    </p>

    <div style="background:#f8f6f6; border:1px solid #ece7e7;
                border-radius:12px; padding:18px 20px; margin:20px 0;">
      <p style="margin:0 0 6px; color:#722F37; font-size:13px; font-weight:bold;">
        ${pct}% COMPLETE
      </p>
      <p style="margin:0 0 4px; color:#333333; font-size:15px;">
        Paid so far: <strong>${naira(paid)}</strong> of ${naira(goal)}
      </p>
      <p style="margin:0; color:#722F37; font-size:16px; font-weight:bold;">
        Balance remaining: ${naira(owed)}
      </p>
    </div>

    <p style="color:#555555; font-size:15px; line-height:1.7;">
      <strong>PLEASE MAKE YOUR PAYMENT NOW.</strong> Do not wait until
      the last minute. You can complete your payment through your camp
      portal using card, bank account, USSD or bank transfer.
    </p>

    <div style="text-align:center; margin:30px 0;">
      <a href="${escapeHtml(portal)}/dashboard"
         style="display:inline-block; background:#722F37; color:#ffffff;
                padding:15px 32px; border-radius:10px; text-decoration:none;
                font-size:14px; font-weight:bold;">
        PAY MY BALANCE NOW
      </a>
    </div>

    <p style="color:#b42318; font-size:15px; font-weight:bold;
              text-align:center; line-height:1.7;">
      ⏰ LESS THAN 50 HOURS LEFT — DON'T DELAY!
    </p>

    ${
      note
        ? noteBox(`<strong>A note from the organisers:</strong> ${escapeHtml(note)}`)
        : ""
    }

    <p style="color:#777777; font-size:13px; line-height:1.6;">
      If you have already paid recently, please ignore this reminder.
      Your portal balance will update once your payment is confirmed.
      If you encounter any payment issues, please contact the camp organisers.
    </p>
  `,
});

  return sendMail({
    to: email,
    name,
    subject: "Gentle Reminder: Your UBC Youth Camp Balance",
    htmlContent,
  });
};

module.exports = {
  sendMail,
  sendResetPasswordMail,
  sendMigrationNoticeMail,
  sendPaymentReminderMail,
};
