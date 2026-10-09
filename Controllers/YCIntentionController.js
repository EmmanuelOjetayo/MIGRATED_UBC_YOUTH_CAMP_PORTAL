// CAMP-Backend/Controllers/YCIntentionController.js
// Campers (or the agent on their behalf) record when they plan to
// complete a partial payment. Latest intention is reused for
// personal follow-up and reminder personalisation.
const YCPaymentIntention = require("../Model/YCPaymentIntention");

const SaveIntention = async (req, res, next) => {
  try {
    const note = String(req.body?.note || "").trim().slice(0, 300);
    if (!note) {
      return res
        .status(400)
        .json({ success: false, message: "note is required" });
    }
    const doc = await YCPaymentIntention.create({
      userId: req.user._id,
      note,
      intendToPayAt: String(req.body?.intendToPayAt || "").slice(0, 60),
      createdBy: req.body?.createdBy === "admin" ? "admin" : "camper",
    });
    res.status(201).json({ success: true, intention: doc });
  } catch (error) {
    next(error);
  }
};

const LatestIntention = async (req, res, next) => {
  try {
    const userId = req.params.userId || req.user._id;
    const doc = await YCPaymentIntention.findOne({ userId })
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ success: true, intention: doc || null });
  } catch (error) {
    next(error);
  }
};

module.exports = { SaveIntention, LatestIntention };
