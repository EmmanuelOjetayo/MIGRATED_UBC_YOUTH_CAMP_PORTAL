const mongoose = require("mongoose");
const axios = require("axios");

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");

// ─────────────────────────────────────────────────────────────
// CAMP business rules — the CURRENT 8-team / ₦5,000 implementation.
// These deliberately replace the legacy Appwrite values
// (₦4,000 and OPAJOBI/ABIMBOLA/ABIOLA/UBC).
// ─────────────────────────────────────────────────────────────

const TEAMS = [
  "KETER",
  "KAVOD",
  "KISSEH",
  "KLIRONOMOS",
  "ARMON",
  "SHARBIT",
  "MALCHUT",
  "MEMSHALAH",
];

const BUSES = ["1", "2", "3", "4", "5"];

const TARGET_FEE = Number(process.env.CAMP_TARGET_FEE) || 5000;

// CAMP-specific Flutterwave credentials. The GLS backend keeps
// using its own credentials and is never referenced here.
const FLW_SECRET_KEY = process.env.CAMP_FLW_SECRET_KEY;
const FLW_SECRET_HASH = process.env.CAMP_FLW_SECRET_HASH;
const FLW_PUBLIC_KEY = process.env.CAMP_FLW_PUBLIC_KEY;

// ─────────────────────────────────────────────────────────────
// CAMP LOGISTICS ASSIGNMENT
//
// Runs exactly once, the first time a camper crosses the target
// fee. Assigns team, bus and a gender-specific bed number, with
// collision protection so two campers never share a bed.
// ─────────────────────────────────────────────────────────────

const assignYCLogistics = async (camper) => {
  const prefix =
    camper.gender === "Male" || camper.gender === "M" ? "M" : "F";

  // Probe for a free team+bus+bed combination. We start from the
  // deterministic slot (global paid count) and walk forward until we
  // find a bed that is not already taken. This prevents two campers
  // who cross the target fee simultaneously from being assigned the
  // same team/bus/bed.
  const globalPaidCount = await YCUser.countDocuments({
    team: { $ne: null },
  });

  const genderPaidCount = await YCUser.countDocuments({
    gender: camper.gender,
    bed_no: { $ne: null },
  });

  let teamAssigned = false;
  let attempts = 0;
  const maxAttempts = TEAMS.length * BUSES.length * 100;

  while (!teamAssigned && attempts < maxAttempts) {
    const slot = globalPaidCount + attempts;
    const candidateTeam = TEAMS[slot % TEAMS.length];
    const candidateBus = BUSES[slot % BUSES.length];

    let bedNum = genderPaidCount + 1;
    let bedAssigned = false;
    let candidateBed = "";

    while (!bedAssigned) {
      const candidate = `${prefix}-${String(bedNum).padStart(3, "0")}`;
      const existingBed = await YCUser.findOne({ bed_no: candidate });

      if (!existingBed) {
        candidateBed = candidate;
        bedAssigned = true;
      } else {
        bedNum++;
      }
    }

    // Verify the team+bus+bed combination is not already taken.
    const clash = await YCUser.findOne({
      team: candidateTeam,
      bus_no: candidateBus,
      bed_no: candidateBed,
    });

    if (!clash) {
      camper.team = candidateTeam;
      camper.bus_no = candidateBus;
      camper.bed_no = candidateBed;
      teamAssigned = true;
    }

    attempts++;
  }

  if (!teamAssigned) {
    // Extremely unlikely: all combinations exhausted. Fall back to a
    // random assignment to avoid blocking the payment.
    camper.team = TEAMS[Math.floor(Math.random() * TEAMS.length)];
    camper.bus_no = BUSES[Math.floor(Math.random() * BUSES.length)];
    camper.bed_no = `${prefix}-${String(genderPaidCount + 1).padStart(3, "0")}`;
  }

  console.log(
    `[YC LOGISTICS] Camper ${camper._id} → Team: ${camper.team} | Bus: ${camper.bus_no} | Bed: ${camper.bed_no}`
  );
};

// ─────────────────────────────────────────────────────────────
// 1. INITIATE CAMP PAYMENT
//    POST /api/ycpayment/initiate
//
// Mints the transaction reference SERVER-SIDE so the camper id and
// the reference can never be forged by the client. The reference is
// returned to the frontend, which passes it to Flutterwave checkout.
// ─────────────────────────────────────────────────────────────

const initiatePayment = async (req, res, next) => {
  try {
    const camper = await YCUser.findById(req.user._id).select("-password");

    if (!camper) {
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    const amount = Number(req.body?.amount || 0);
    const currentBalance = parseFloat(camper.amount_paid || 0);
    const remaining = Math.max(TARGET_FEE - currentBalance, 0);

    if (amount <= 0) {
      const err = new Error("Payment amount must be greater than zero");
      err.statusCode = 400;
      throw err;
    }

    if (amount > remaining) {
      const err = new Error(
        `You only owe ₦${remaining.toLocaleString()} to complete your camp fee.`
      );
      err.statusCode = 400;
      throw err;
    }

    // Server-generated, collision-resistant merchant reference.
    const reference = `YC-${camper._id}-${Date.now()}`;

    res.status(200).json({
      success: true,
      message: "Payment initialized",
      data: {
        reference,
        tx_ref: reference,
        amount,
        currency: "NGN",
        email: camper.email,
        name: camper.name,
        phone: camper.phone || "08000000000",
        public_key: FLW_PUBLIC_KEY,
        camper_id: String(camper._id),
        type: "ubcyc",
        remaining,
        targetFee: TARGET_FEE,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// FLUTTERWAVE FETCH WITH FALLBACK / RECOVERY
//
// Primary : GET /transactions/{id}/verify   (one retry for transient
//           network / 5xx errors)
// Fallback: GET /transactions/verify_by_reference?reference=…
//           (recovers the same transaction when the primary endpoint
//           is down or the id is unknown)
//
// Returns a normalised `{ status, data }` payload or null when BOTH
// attempts fail — callers then return a recoverable 502 so the
// frontend can use /recovery and Flutterwave's webhook retry will
// also re-enter the same idempotent path.
// ─────────────────────────────────────────────────────────────

const flwGet = (url) =>
  axios.get(url, {
    headers: {
      Authorization: `Bearer ${FLW_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

const fetchFlwTransaction = async (transactionId, txRef) => {
  // ── PRIMARY: verify by transaction id (with one retry) ──
  if (transactionId) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await flwGet(
          `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`
        );
        if (res.data) return res.data;
      } catch (flwError) {
        console.error(
          `[YC FLW VERIFY] attempt ${attempt}/${2} failed for TX ${transactionId}: ${flwError.message}`
        );
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
  }

  // ── FALLBACK: verify by our merchant reference ──
  if (txRef) {
    try {
      const res = await flwGet(
        `https://api.flutterwave.com/v3/transactions/verify_by_reference?reference=${encodeURIComponent(txRef)}`
      );
      const payload = res.data;
      const row = Array.isArray(payload?.data)
        ? payload.data[0]
        : payload?.data;
      if (row && row.id) {
        return { status: payload.status, data: row };
      }
    } catch (flwError) {
      console.error(
        `[YC FLW VERIFY-BY-REFERENCE] failed for ref ${txRef}: ${flwError.message}`
      );
    }
  }

  return null;
};

// ─────────────────────────────────────────────────────────────
// WEBHOOK CAMPER-RESOLUTION HELPERS
//
// The frontend callback carries a JWT, so camper identity is trivial.
// The server-to-server webhook carries NO JWT, so identity must be
// recovered from the (verified) Flutterwave payload with layered
// fallbacks. Each step is best-effort; a single mismatched field
// must never block the whole webhook.
// ─────────────────────────────────────────────────────────────

// Escape user-controlled text before embedding it in a RegExp.
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Flutterwave `meta` arrives in different shapes depending on the
// integration (inline checkout object vs. array of name/value pairs).
// Normalise every shape to a plain { camper_id?, camperId? } lookup.
const readMetaCamperId = (meta) => {
  if (!meta) return null;
  if (typeof meta === "object" && !Array.isArray(meta)) {
    return meta.camper_id || meta.camperId || meta.CAMPER_ID || null;
  }
  if (Array.isArray(meta)) {
    for (const entry of meta) {
      const k = String(entry?.metaname || entry?.name || "").toLowerCase();
      if (k === "camper_id" || k === "camperid" || k === "camper-id") {
        return entry?.metavalue ?? entry?.value ?? null;
      }
    }
  }
  return null;
};

// Our merchant references embed the camper id:
//   backend /initiate : `YC-<camperId>-<timestamp>`
//   frontend checkout : `UBC-<camperId>-<timestamp>` (current live format)
// Either prefix is accepted; the id is validated as an ObjectId later.
const parseCamperIdFromRef = (txRef) => {
  if (!txRef) return null;
  const m = String(txRef).match(/^(?:YC|UBC)-([a-fA-F0-9]{24})-\d+$/);
  return m ? m[1] : null;
};

// Normalise a phone number to its last 10 digits so that
// "+234 805…", "234805…", "0805…" and "805…" all compare equal.
const phoneDigits = (p) => String(p || "").replace(/\D/g, "");
const phoneLast10 = (p) => {
  const d = phoneDigits(p).replace(/^234/, "").replace(/^0+/, "");
  return d.slice(-10);
};

// Full webhook camper-resolution chain. Returns
// `{ camperId, via }` or `{ camperId: null, via: null }`.
// `via` names the winning strategy for observability.
const resolveWebhookCamper = async ({ requestMeta, flwData, txRef }) => {
  // ① meta from the raw webhook body (what the checkout sent)
  let camperId = readMetaCamperId(requestMeta);
  if (camperId) return { camperId: String(camperId), via: "request-meta" };

  // ② meta echoed inside the VERIFIED Flutterwave response (trustworthy)
  camperId = readMetaCamperId(flwData?.data?.meta);
  if (camperId) return { camperId: String(camperId), via: "verified-meta" };

  // ③ camper id embedded in our own merchant reference (YC- or UBC-)
  camperId = parseCamperIdFromRef(txRef);
  if (camperId) {
    const exists = await YCUser.exists({ _id: camperId });
    if (exists) return { camperId, via: "tx-ref" };
  }

  const customer = flwData?.data?.customer || {};

  // ④ email lookup — schema stores lowercase, so normalise first
  if (customer.email) {
    const email = String(customer.email).trim().toLowerCase();
    if (email) {
      const emailMatch = await YCUser.findOne({ email }).select("_id");
      if (emailMatch)
        return { camperId: emailMatch._id.toString(), via: "email" };
    }
  }

  // ⑤ phone lookup — compare last-10-digits so formatting never blocks us
  const flwPhone10 = phoneLast10(customer.phone_number);
  if (flwPhone10 && flwPhone10.length === 10) {
    const candidates = await YCUser.find({
      phone: { $exists: true, $ne: null },
    })
      .select("_id phone")
      .lean();
    const hit = candidates.find((c) => phoneLast10(c.phone) === flwPhone10);
    if (hit) return { camperId: hit._id.toString(), via: "phone" };
  }

  // ⑥ name fallback — escaped first+last token match (last resort)
  if (customer.name) {
    const tokens = String(customer.name).trim().split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const first = escapeRegExp(tokens[0]);
      const last = escapeRegExp(tokens[tokens.length - 1]);
      const nameMatch = await YCUser.findOne({
        $or: [
          { name: new RegExp(`^${first}.*${last}$`, "i") },
          { name: new RegExp(`^${last}.*${first}$`, "i") },
        ],
      }).select("_id");
      if (nameMatch)
        return { camperId: nameMatch._id.toString(), via: "name" };
    }
  }

  return { camperId: null, via: null };
};

// ─────────────────────────────────────────────────────────────
// 2. VERIFY CAMP PAYMENT
//    POST /api/ycpayment/verify
//
// Handles BOTH the Flutterwave webhook and the frontend callback.
// The transaction is always verified server-to-server with
// Flutterwave before any credit is applied.
// ─────────────────────────────────────────────────────────────

const verifyPayment = async (req, res, next) => {
  try {
    const body = req.body || {};

    // A genuine webhook carries the `verif-hash` header matching the
    // CAMP secret hash. Anything else is treated as a client callback.
    const signature = req.headers["verif-hash"];
    const isWebhook = Boolean(
      signature && FLW_SECRET_HASH && signature === FLW_SECRET_HASH
    );

    let transactionId;
    let txRef;
    let camperId;
    let requestMeta = null;

    if (isWebhook) {
      const data = body.data || body;

      // FLW transaction id may arrive as `id` (webhook) or
      // `transaction_id` (some event shapes) — accept both.
      transactionId = (data.id ?? data.transaction_id)?.toString();
      txRef = data.tx_ref || data.txRef;
      requestMeta = data.meta ?? null;

      // Fast path: meta.camper_id when Flutterwave echoes it.
      // NOT required — the full fallback chain runs after the
      // server-to-server verification below, so a missing meta
      // must never throw here.
      camperId = readMetaCamperId(requestMeta);
      if (camperId) camperId = String(camperId);
    } else {
      // Callback path: camper identity comes from the verified JWT,
      // never from the request body.
      transactionId = body.transaction_id?.toString();
      txRef = body.tx_ref;
      camperId = req.user?._id?.toString() || body.camperId || null;
    }

    if (!transactionId || !txRef) {
      // A webhook without identifiers is FLW's problem, not ours —
      // answer 200 so Flutterwave stops retrying a payload we can
      // never resolve. The callback path still throws so the
      // frontend can surface the error to the camper.
      if (isWebhook) {
        console.error(
          `[YC WEBHOOK] Unresolvable payload (no id/tx_ref). event=${body?.event || "unknown"}`
        );
        return res.status(200).json({
          success: false,
          message: "Payload carried no transaction identifiers",
          actionable: false,
        });
      }
      const err = new Error("Incomplete transaction data");
      err.statusCode = 400;
      throw err;
    }

    // NOTE: no `if (!camperId) throw` here. The webhook has no JWT,
    // so identity is resolved AFTER verification from the verified
    // Flutterwave payload (meta → tx-ref → email → phone → name).
    // Only the JWT callback path requires identity up-front:
    if (!isWebhook && !camperId) {
      const err = new Error("Could not identify camper for this transaction");
      err.statusCode = 400;
      throw err;
    }

    // ── VERIFY WITH FLUTTERWAVE (source of truth) ──
    // fetchFlwTransaction already retries the primary endpoint and
    // falls back to verify-by-reference before giving up.
    const flwData = await fetchFlwTransaction(transactionId, txRef);

    if (!flwData) {
      console.error(
        `[YC FLW VERIFY EXHAUSTED] TX: ${transactionId} | ref: ${txRef}`
      );
      const err = new Error(
        "Payment verification is temporarily unavailable. Please retry in a moment — your payment is safe and will also be confirmed automatically by the webhook."
      );
      err.statusCode = 502;
      err.recoverable = true;
      throw err;
    }

    // A non-successful charge is DEFINITIVE, not transient — telling
    // Flutterwave 200 stops pointless retries. The camper simply
    // wasn't charged, so there is nothing to credit.
    if (
      flwData.status !== "success" ||
      flwData.data?.status !== "successful"
    ) {
      console.warn(
        `[YC FLW NOT-SUCCESSFUL] TX: ${transactionId} | ref: ${txRef} | flwStatus: ${flwData.data?.status}`
      );
      if (isWebhook) {
        return res.status(200).json({
          success: false,
          message: "Charge was not successful — nothing to credit",
          actionable: false,
        });
      }
      const err = new Error("Flutterwave verification failed");
      err.statusCode = 400;
      throw err;
    }

    // ── WEBHOOK CAMPER RESOLUTION (full fallback chain) ──
    // Runs AFTER server-to-server verification, against VERIFIED data.
    // Order: request-meta → verified-meta → tx-ref (YC-/UBC-) →
    // email → phone (last-10) → name. The winning strategy is logged.
    if (isWebhook && !camperId) {
      const resolved = await resolveWebhookCamper({
        requestMeta,
        flwData,
        txRef,
      });
      camperId = resolved.camperId;
      if (camperId) {
        console.log(
          `[YC WEBHOOK] Camper resolved via ${resolved.via}: ${camperId} | ref: ${txRef}`
        );
      }
    }

    if (!camperId || !mongoose.Types.ObjectId.isValid(camperId)) {
      // Deterministic failure — retrying won't invent an identity.
      // Answer 200 with needsAttention so ops can reconcile manually
      // from the logged tx_ref / transaction id, instead of letting
      // Flutterwave hammer a dead end.
      console.error(
        `[YC WEBHOOK] Camper UNRESOLVABLE after all fallbacks | ref: ${txRef} | TX: ${transactionId} | email: ${flwData?.data?.customer?.email || "—"} | phone: ${flwData?.data?.customer?.phone_number || "—"} | name: ${flwData?.data?.customer?.name || "—"}`
      );
      if (isWebhook) {
        return res.status(200).json({
          success: false,
          message: "Payment verified but camper could not be identified",
          needsAttention: true,
          tx_ref: txRef,
          transaction_id: transactionId,
        });
      }
      const err = new Error("Invalid camper identifier");
      err.statusCode = 400;
      throw err;
    }

    // ── SECURITY: the verified tx_ref must match what we were given ──
    if (flwData.data.tx_ref !== txRef) {
      console.error(
        `[YC SECURITY] tx_ref mismatch. Expected: ${txRef}, Got: ${flwData.data.tx_ref}`
      );
      const err = new Error("Transaction reference mismatch");
      err.statusCode = 400;
      throw err;
    }

    // ── AMOUNT: credit only the settled (net) Naira amount ──
    const rawAmount = parseFloat(
      flwData.data.amount_settled || flwData.data.amount || 0
    );
    const netAmount = Math.floor(rawAmount / 100) * 100;

    if (netAmount <= 0) {
      const err = new Error("Invalid settlement amount");
      err.statusCode = 400;
      throw err;
    }

    // ── IDEMPOTENCY ──────────────────────────────────────────────
    // Checked BEFORE any balance is touched. A repeated webhook
    // returns success WITHOUT crediting the camper a second time.
    //
    // This application-level check is backed by unique indexes on
    // `reference` and `transactionId` in the YCPayment schema, so a
    // simultaneous duplicate is rejected by MongoDB as well.
    const existingPayment = await YCPayment.findOne({
      $or: [{ reference: txRef }, { transactionId }],
    });

    if (existingPayment) {
      console.log(`[YC DUPLICATE] Blocked for TX: ${transactionId}`);
      return res.status(200).json({
        success: true,
        message: "Transaction already processed",
        idempotent: true,
      });
    }

    // ── Confirm the camper exists BEFORE writing a payment record ──
    const camper = await YCUser.findById(camperId);

    if (!camper) {
      console.error(`[YC CRITICAL] Camper not found: ${camperId}`);
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    // ── Create the YCPayment record ──
    try {
      await YCPayment.create({
        camperId,
        transactionId,
        amount: netAmount,
        grossAmount: parseFloat(flwData.data.amount || 0),
        fees: parseFloat(flwData.data.app_fee || 0),
        currency: flwData.data.currency || "NGN",
        channel: flwData.data.payment_channel || undefined,
        reference: txRef,
        date: new Date(),
        year: new Date().getFullYear(),
        status: "success",
      });
    } catch (createError) {
      // Unique-index violation means a concurrent request won the race.
      if (createError.code === 11000) {
        console.log(`[YC DUPLICATE RACE] Blocked for TX: ${transactionId}`);
        return res.status(200).json({
          success: true,
          message: "Transaction already processed",
          idempotent: true,
        });
      }
      throw createError;
    }

    // ── Update camper wallet ──
    const newBalance = parseFloat(camper.amount_paid || 0) + netAmount;
    camper.amount_paid = newBalance;
    camper.status = newBalance >= TARGET_FEE ? "paid" : "pending";

    // ── Logistics assignment, only on first crossing the target ──
    if (newBalance >= TARGET_FEE && !camper.team) {
      await assignYCLogistics(camper);
    }

    await camper.save();

    console.log(
      `[YC COMPLETE] Camper: ${camperId} | Credited: ₦${netAmount} | New Balance: ₦${newBalance}`
    );

    return res.status(200).json({
      success: true,
      message: "Wallet Synced",
      credited: netAmount,
      newBalance: camper.amount_paid,
      status: camper.status,
      team: camper.team,
      bus_no: camper.bus_no,
      bed_no: camper.bed_no,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// 2b. PAYMENT RECOVERY (client-triggered fallback)
//     POST /api/ycpayment/recovery   { tx_ref, transaction_id? }
//
// Used by the frontend when /verify returns a recoverable error
// (e.g. Flutterwave temporarily unreachable). Re-enters the exact
// same idempotent verification path — the camper identity comes
// from the caller's JWT. Safe to call repeatedly.
// ─────────────────────────────────────────────────────────────

const recoverPayment = async (req, res, next) => {
  try {
    const txRef = String(req.body?.tx_ref || "").trim();
    if (!txRef) {
      const err = new Error("tx_ref is required");
      err.statusCode = 400;
      throw err;
    }

    let transactionId = req.body?.transaction_id?.toString();

    // If the client has no transaction id, resolve it from Flutterwave
    // using our merchant reference (the by-reference fallback).
    if (!transactionId) {
      const found = await fetchFlwTransaction(null, txRef);
      transactionId = found?.data?.id?.toString();
      if (!transactionId) {
        const err = new Error(
          "Payment verification is still unavailable. Your payment is safe — please retry shortly."
        );
        err.statusCode = 502;
        err.recoverable = true;
        throw err;
      }
    }

    req.body = { ...req.body, tx_ref: txRef, transaction_id: transactionId };
    return verifyPayment(req, res, next);
  } catch (error) {
    return next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// 3. FLUTTERWAVE WEBHOOK (dedicated endpoint)
//    POST /api/ycpayment/webhook
//
// Flutterwave sends the `verif-hash` header, which is checked
// against the CAMP secret hash inside verifyPayment.
// ─────────────────────────────────────────────────────────────

const flutterwaveWebhook = async (req, res, next) => {
  try {
    const signature = req.headers["verif-hash"];

    // Misconfiguration is the #1 webhook killer: without the secret
    // hash we reject EVERYTHING with 401 and Flutterwave flags the
    // endpoint as failing. Log loudly so ops notices immediately.
    if (!FLW_SECRET_HASH) {
      console.error(
        "[YC WEBHOOK] CAMP_FLW_SECRET_HASH is not set — every webhook is being rejected. Set it to the Secret Hash from the Flutterwave dashboard (Settings → Webhooks)."
      );
      return res.status(500).json({
        success: false,
        message: "Webhook receiver misconfigured",
      });
    }

    if (signature !== FLW_SECRET_HASH) {
      console.warn("[YC WEBHOOK] Rejected: invalid verif-hash signature");
      return res.status(401).json({
        success: false,
        message: "Invalid webhook signature",
      });
    }

    const event = req.body?.event || "unknown-event";
    const txRef =
      req.body?.data?.tx_ref || req.body?.tx_ref || "unknown tx_ref";
    console.log(`[YC WEBHOOK] Received event=${event} ref=${txRef}`);

    // Flutterwave dashboard "Test" button and non-charge events carry
    // no creditable transaction — acknowledge without processing.
    if (event !== "unknown-event" && event !== "charge.completed") {
      console.log(`[YC WEBHOOK] Ignoring non-charge event: ${event}`);
      return res.status(200).json({ success: true, message: "Event ignored" });
    }

    // Delegates to the same idempotent verification path.
    return verifyPayment(req, res, next);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  initiatePayment,
  verifyPayment,
  recoverPayment,
  flutterwaveWebhook,
};