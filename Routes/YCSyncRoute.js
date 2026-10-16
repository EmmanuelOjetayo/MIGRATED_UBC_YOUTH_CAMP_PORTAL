// ─────────────────────────────────────────────────────────────
// CAMP-Backend/Routes/YCSyncRoute.js
//
// OFFLINE SYNC ENDPOINT (additive, OPT-IN).
//
// Lets the offline admin PWA hand the backend a batch of operations
// recorded while offline. It is mounted at BOTH:
//   /api/admin/sync/*   (used by the PWA)
//   /api/ycadmin/sync/* (canonical namespace)
// and ONLY when ENABLE_OFFLINE_SYNC=true (see Server/app.js). With the
// flag off the router is never registered and these paths 404.
//
// SAFETY
//   • Same auth as every admin route: ycAuth + adminOnly.
//   • Every operation carries an `opId`. A unique index on
//     YCSyncOp.opId makes replaying an operation a no-op.
//   • Meal + souvenir rules are still enforced by the EXISTING
//     unique indexes on YCMealLog and YCSouvenir — this route
//     cannot create a duplicate meal or a second souvenir.
//   • Nothing here reads or writes GLS data, and no existing
//     endpoint or collection is modified.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const joi = require("joi");

const ycAuth = require("../Middleware/YCAuthMiddleware");
const YCUser = require("../Model/YCUser");
const YCMealLog = require("../Model/YCMealLog");
const YCSouvenir = require("../Model/YCSouvenir");
const YCSyncOp = require("../Model/YCSyncOp");

const YCSyncRoute = express.Router();

const adminOnly = (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized." });
  if (req.user.role !== "admin")
    return res.status(403).json({ success: false, message: "Access denied. Admin only." });
  next();
};

const opSchema = joi.object({
  opId: joi.string().required(),
  type: joi.string().valid("meal_scan", "souvenir_scan", "role_update").required(),
  camperId: joi.string().pattern(/^[0-9a-fA-F]{24}$/).allow(null),
  dedupeKey: joi.string().allow(null),
  deviceId: joi.string().allow(null, ""),
  adminId: joi.string().allow(null, ""),
  createdAt: joi.string().allow(null),
  revision: joi.number().default(0),
  payload: joi.object().default({}),
});

// Same rule POST /admin/meal-scan uses: normalises "YYYY-MM-DD" to the
// stored "YYYY-MM-DDT00:00:00.000Z" form so a meal recorded through
// either path collides on the same { camperId, meal_type, day } key.
const mealDaySchema = joi.string().isoDate().required();

const pushSchema = joi.object({
  operations: joi.array().items(opSchema).max(2000).required(),
});

// ── apply ONE operation idempotently ─────────────────────────
async function applyOperation(op, admin) {
  // 1. Idempotency ledger: has this exact opId been applied?
  const existing = await YCSyncOp.findOne({ opId: op.opId });
  if (existing) {
    return {
      opId: op.opId,
      status: existing.status === "applied" ? "synced" : existing.status,
      reason: existing.reason || "already_applied",
      resultId: existing.resultId,
    };
  }

  let resultId = null;
  let status = "applied";
  let reason = null;

  try {
    if (op.type === "meal_scan") {
      const mealType = op.payload?.mealType;
      const rawDay = op.payload?.day;
      // Normalise `day` exactly as the existing endpoint does, so a meal
      // recorded by the live app (or the fallback path) and the same meal
      // pushed in a batch resolve to the SAME stored value.
      const { error: dayError, value: day } = mealDaySchema.validate(rawDay);
      if (!op.camperId || !mealType || !rawDay) {
        status = "rejected"; reason = "missing_fields";
      } else if (dayError) {
        status = "rejected"; reason = "invalid_day";
      } else {
        // Upsert keyed by the EXISTING unique index { camperId, meal_type, day }.
        const log = await YCMealLog.findOneAndUpdate(
          { camperId: op.camperId, meal_type: mealType, day },
          {
            $setOnInsert: {
              camperId: op.camperId,
              meal_type: mealType,
              day,
              scanned_at: op.createdAt ? new Date(op.createdAt) : new Date(),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        resultId = String(log._id);
        // If the record already existed this is an idempotent no-op.
        reason = "meal_recorded";
      }
    } else if (op.type === "souvenir_scan") {
      if (!op.camperId) {
        status = "rejected"; reason = "missing_camper";
      } else {
        const existingSouvenir = await YCSouvenir.findOne({ camperId: op.camperId });
        if (existingSouvenir) {
          // One souvenir per camper — acknowledge so the device stops retrying.
          resultId = String(existingSouvenir._id);
          reason = "already_issued";
        } else {
          const camper = await YCUser.findById(op.camperId);
          if (!camper) {
            status = "rejected"; reason = "camper_not_found";
          } else {
            const created = await YCSouvenir.create({
              camperId: camper._id,
              camperName: camper.name,
              phone: camper.phone,
              level: camper.team,
              collected_at: op.createdAt ? new Date(op.createdAt) : new Date(),
            });
            resultId = String(created._id);
            reason = "souvenir_issued";
          }
        }
      }
    } else if (op.type === "role_update") {
      const role = op.payload?.role;
      if (!op.camperId || !["user", "admin"].includes(role)) {
        status = "rejected"; reason = "invalid_role";
      } else {
        const user = await YCUser.findById(op.camperId);
        if (!user) {
          status = "rejected"; reason = "camper_not_found";
        } else {
          user.role = role;
          await user.save();
          resultId = String(user._id);
          reason = "role_updated";
        }
      }
    } else {
      status = "rejected"; reason = "unknown_type";
    }
  } catch (e) {
    // A duplicate-key error from the unique indexes is NOT a failure:
    // it means the business rule already holds server-side.
    if (e && e.code === 11000) {
      status = "applied";
      reason = "duplicate_business_rule";
    } else {
      status = "rejected";
      reason = e.message;
    }
  }

  // 2. Record the ledger entry (idempotent thanks to the unique index).
  try {
    await YCSyncOp.create({
      opId: op.opId,
      type: op.type,
      dedupeKey: op.dedupeKey || null,
      camperId: op.camperId || null,
      deviceId: op.deviceId || null,
      adminId: admin?._id || (op.adminId || null),
      clientCreatedAt: op.createdAt ? new Date(op.createdAt) : null,
      resultId,
      status,
      reason,
      payload: op.payload || {},
    });
  } catch (e) {
    if (e.code !== 11000) throw e; // 11000 = concurrent insert, fine
  }

  return { opId: op.opId, status: status === "applied" ? "synced" : status, reason, resultId };
}

// ── POST /sync/push ──────────────────────────────────────────
YCSyncRoute.post("/push", ycAuth, adminOnly, async (req, res, next) => {
  try {
    const { error, value } = pushSchema.validate(req.body, { abortEarly: false });
    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const synced = [];
    const conflicts = [];

    for (const op of value.operations) {
      try {
        const ack = await applyOperation(op, req.user);
        if (ack.status === "synced") synced.push(ack);
        else conflicts.push(ack);
      } catch (e) {
        conflicts.push({ opId: op.opId, reason: e.message });
      }
    }

    res.status(200).json({
      success: true,
      received: value.operations.length,
      synced,
      conflicts,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = YCSyncRoute;
