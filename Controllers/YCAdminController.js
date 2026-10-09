const joi = require("joi");

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");
const YCMealLog = require("../Model/YCMealLog");
const YCSouvenir = require("../Model/YCSouvenir");

// Reminder audit trail (expense-linked reminders; consumed by the agent
// admin tools and shown in the camper dashboard).
const YCReminderLog = require("../Model/YCReminderLog");

const TARGET_FEE = Number(process.env.CAMP_TARGET_FEE) || 5000;

// CAMP ADMIN CONTROLLER
// Owns: camper listing, payment listing, meal scanning,
//       souvenir scanning, souvenir reports, role updates.

// ── 1. LIST ALL CAMPERS ──
const GetCampers = async (req, res, next) => {
  try {
    const campers = await YCUser.find().sort({ createdAt: 1 }).select("-password");

    res.status(200).json({
      success: true,
      campers,
    });
  } catch (error) {
    next(error);
  }
};

// ── 2. LIST ALL PAYMENTS ──
const GetPayments = async (req, res, next) => {
  try {
    const payments = await YCPayment.find().sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      payments,
    });
  } catch (error) {
    next(error);
  }
};

// ── 3. GET MEAL LOGS FOR A DAY ──
const GetMealLogs = async (req, res, next) => {
  try {
    const { day } = req.query;

    const logs = await YCMealLog.find(day ? { day } : {}).sort({
      createdAt: -1,
    });

    res.status(200).json({
      success: true,
      logs,
    });
  } catch (error) {
    next(error);
  }
};

// ── 4. LIST ALL SOUVENIRS ──
const GetSouvenirs = async (req, res, next) => {
  try {
    const souvenirs = await YCSouvenir.find().sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      souvenirs,
      logs: souvenirs,
    });
  } catch (error) {
    next(error);
  }
};

// ── 5. SOUVENIR COUNT ──
const GetSouvenirCount = async (req, res, next) => {
  try {
    const count = await YCSouvenir.countDocuments();

    res.status(200).json({
      success: true,
      count,
    });
  } catch (error) {
    next(error);
  }
};

// ── 6. SCAN SOUVENIR ──
// The unique index on YCSouvenir.camperId guarantees one souvenir
// per camper even if a scan is repeated.
const souvenirScanSchema = joi.object({
  camperId: joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
});

const ScanSouvenir = async (req, res, next) => {
  try {
    const { error, value } = souvenirScanSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const { camperId } = value;

    const camper = await YCUser.findById(camperId);

    if (!camper) {
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    const existing = await YCSouvenir.findOne({ camperId });

    if (existing) {
      const err = new Error("This camper already received a souvenir.");
      err.statusCode = 409;
      throw err;
    }

    const newSouvenir = await YCSouvenir.create({
      camperId: camper._id,
      camperName: camper.name,
      phone: camper.phone,
      level: camper.team,
      collected_at: new Date(),
    });

    res.status(201).json({
      success: true,
      message: "Souvenir issued successfully",
      camper,
      log: newSouvenir,
    });
  } catch (error) {
    next(error);
  }
};

// ── 7. SCAN MEAL ──
const mealSchema = joi.object({
  camperId: joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  mealType: joi.string().valid("Breakfast", "Lunch", "Dinner").required(),
  day: joi.string().isoDate().required(),
});

const ScanMeal = async (req, res, next) => {
  try {
    const { error, value } = mealSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const { camperId, mealType, day } = value;

    const camper = await YCUser.findById(camperId);

    if (!camper) {
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    const existing = await YCMealLog.findOne({
      camperId,
      meal_type: mealType,
      day,
    });

    if (existing) {
      const err = new Error(`Already received ${mealType} today`);
      err.statusCode = 409;
      throw err;
    }

    const newMealRecord = await YCMealLog.create({
      camperId,
      meal_type: mealType,
      day,
      scanned_at: new Date(),
    });

    res.status(201).json({
      success: true,
      message: `${mealType} logged successfully`,
      camper,
      log: newMealRecord,
    });
  } catch (error) {
    next(error);
  }
};

// ── 8. UPDATE CAMPER ROLE ──
const roleSchema = joi.object({
  role: joi.string().valid("user", "admin").required(),
});

const RoleUpdate = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { error, value } = roleSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const foundUser = await YCUser.findById(id);

    if (!foundUser) {
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    foundUser.role = value.role;
    await foundUser.save();

    res.status(200).json({
      success: true,
      message: "Role Updated Successfully",
      camper: foundUser.toObject(),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  GetCampers,
  GetPayments,
  GetMealLogs,
  GetSouvenirs,
  GetSouvenirCount,
  ScanSouvenir,
  ScanMeal,
  RoleUpdate,
};
