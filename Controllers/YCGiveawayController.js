const joi = require("joi");

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");

// ─────────────────────────────────────────────────────────────
// CAMP GIVEAWAY
//
// A camper may gift their SURPLUS (balance above the target fee)
// to another camper. The sender always keeps at least the target
// fee for themselves.
//
// The sender is taken from the verified JWT, NOT from the request
// body, so a camper can never transfer from someone else's wallet.
// ─────────────────────────────────────────────────────────────

const TARGET_FEE = Number(process.env.CAMP_TARGET_FEE) || 5000;

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

// ─────────────────────────────────────────────────────────────
// Logistics assignment (shared with the payment flow)
// ─────────────────────────────────────────────────────────────

const assignLogistics = async (camper) => {
  const globalPaidCount = await YCUser.countDocuments({
    team: { $ne: null },
  });

  const genderPaidCount = await YCUser.countDocuments({
    gender: camper.gender,
    bed_no: { $ne: null },
  });

  camper.team = TEAMS[globalPaidCount % TEAMS.length];
  camper.bus_no = BUSES[globalPaidCount % BUSES.length];

  const prefix =
    camper.gender === "Male" || camper.gender === "M" ? "M" : "F";

  let bedNum = genderPaidCount + 1;
  let bedAssigned = false;

  while (!bedAssigned) {
    const candidate = `${prefix}-${String(bedNum).padStart(3, "0")}`;
    const existingBed = await YCUser.findOne({ bed_no: candidate });

    if (!existingBed) {
      camper.bed_no = candidate;
      bedAssigned = true;
    } else {
      bedNum++;
    }
  }
};

// ─────────────────────────────────────────────────────────────
// 1. RESOLVE RECEIVER NAME
// ─────────────────────────────────────────────────────────────

// The frontend also sends `senderId`; the sender is actually taken
// from the verified JWT, so that field is tolerated but not trusted.
const resolveSchema = joi.object({
  receiverId: joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
}).unknown(true);

const resolveReceiver = async (req, res, next) => {
  try {
    const { error, value } = resolveSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const senderId = req.user?._id?.toString();

    if (senderId && senderId === value.receiverId) {
      const err = new Error(
        "Illegal Operation: You cannot giveaway funds to yourself."
      );
      err.statusCode = 400;
      throw err;
    }

    const user = await YCUser.findById(value.receiverId);

    if (!user) {
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    res.status(200).json({
      success: true,
      name: user.name,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// 2. TRANSFER GIVEAWAY
// ─────────────────────────────────────────────────────────────

const transferSchema = joi.object({
  receiverId: joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  amount: joi.number().positive().required(),
}).unknown(true);

const transferGiveaway = async (req, res, next) => {
  try {
    const { error, value } = transferSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const { receiverId, amount: rawAmount } = value;
    const transferVal = parseFloat(rawAmount);

    const senderId = req.user?._id?.toString();

    if (!senderId) {
      const err = new Error("Unauthorized");
      err.statusCode = 401;
      throw err;
    }

    if (senderId === receiverId) {
      const err = new Error(
        "Illegal Operation: You cannot send funds to your own account ID."
      );
      err.statusCode = 400;
      throw err;
    }

    const sender = await YCUser.findById(senderId);
    const receiver = await YCUser.findById(receiverId);

    if (!sender || !receiver) {
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    // Surplus check: the sender must retain the full target fee.
    const senderBalance = parseFloat(sender.amount_paid || 0);

    if (senderBalance - transferVal < TARGET_FEE) {
      const err = new Error(
        `Insufficient surplus. You must keep ₦${TARGET_FEE.toLocaleString()} for your own fee.`
      );
      err.statusCode = 400;
      throw err;
    }

    // ── Update balances atomically with compensation ──
    // Use findOneAndUpdate with a conditional filter so the debit only
    // applies when the sender still has sufficient surplus. If any later
    // step fails we compensate by crediting the sender back.
    const debited = await YCUser.findOneAndUpdate(
      { _id: senderId, amount_paid: { $gte: TARGET_FEE + transferVal } },
      { $inc: { amount_paid: -transferVal } },
      { new: true }
    );

    if (!debited) {
      const err = new Error(
        `Insufficient surplus. You must keep ₦${TARGET_FEE.toLocaleString()} for your own fee.`
      );
      err.statusCode = 400;
      throw err;
    }

    const receiverNewBalance = parseFloat(receiver.amount_paid || 0) + transferVal;
    receiver.amount_paid = receiverNewBalance;
    receiver.status = receiverNewBalance >= TARGET_FEE ? "paid" : "pending";

    // A receiver reaching the target via a giveaway still needs
    // their logistics assignment, exactly as with a direct payment.
    if (receiverNewBalance >= TARGET_FEE && !receiver.team) {
      await assignLogistics(receiver);
    }

    try {
      await receiver.save();
    } catch (saveErr) {
      // Compensate: refund the sender.
      await YCUser.updateOne(
        { _id: senderId },
        { $inc: { amount_paid: transferVal } }
      );
      throw saveErr;
    }

    // ── Log both sides of the transfer ──
    const senderFirstName = sender.name
      ? sender.name.split(" ")[0].toUpperCase()
      : "USER";
    const receiverFirstName = receiver.name
      ? receiver.name.split(" ")[0].toUpperCase()
      : "USER";

    try {
      await YCPayment.create([
        {
          camperId: senderId,
          amount: -transferVal,
          reference: `SENT TO ${receiverFirstName}`,
          date: new Date(),
          year: new Date().getFullYear(),
          status: "transfer_out",
        },
        {
          camperId: receiverId,
          amount: transferVal,
          reference: `FROM ${senderFirstName}`,
          date: new Date(),
          year: new Date().getFullYear(),
          status: "transfer_in",
        },
      ]);
    } catch (logErr) {
      // Compensate both balances if the ledger write fails.
      await YCUser.updateOne(
        { _id: senderId },
        { $inc: { amount_paid: transferVal } }
      );
      await YCUser.updateOne(
        { _id: receiverId },
        { $inc: { amount_paid: -transferVal } }
      );
      throw logErr;
    }

    res.status(200).json({
      success: true,
      message: "Transfer successful",
      newBalance: debited.amount_paid,
      receiverName: receiver.name,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  resolveReceiver,
  transferGiveaway,
};