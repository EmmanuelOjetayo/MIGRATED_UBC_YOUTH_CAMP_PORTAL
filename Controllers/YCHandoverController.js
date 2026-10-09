// CAMP-Backend/Controllers/YCHandoverController.js
// Human-handover queue: the agent (or a camper) files questions it
// cannot answer; admins list, resolve, and optionally promote the
// resolution into the FAQ knowledge base.
const YCHandover = require("../Model/YCHandover");
const YCFaq = require("../Model/YCFaq");

// POST /api/ychat/handover  { question, guestId? }
const CreateHandover = async (req, res, next) => {
  try {
    const question = String(req.body?.question || "").trim().slice(0, 2000);
    if (!question) {
      return res
        .status(400)
        .json({ success: false, message: "question is required" });
    }
    const doc = await YCHandover.create({
      userId: req.user ? req.user._id : null,
      guestId: req.user
        ? null
        : String(req.body?.guestId || req.ip || "unknown").slice(0, 128),
      camperName: req.user?.name || "",
      question,
    });
    res.status(201).json({ success: true, handover: doc });
  } catch (error) {
    next(error);
  }
};

// GET /api/ychat/handovers?status=pending  (admin)
const ListHandovers = async (req, res, next) => {
  try {
    const filter =
      req.query.status === "resolved"
        ? { status: "resolved" }
        : req.query.status === "all"
          ? {}
          : { status: "pending" };
    const items = await YCHandover.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("userId", "name email phone")
      .lean();
    res.status(200).json({ success: true, count: items.length, handovers: items });
  } catch (error) {
    next(error);
  }
};

// POST /api/ychat/handovers/:id/resolve  { answer, promoteToFaq? }  (admin)
const ResolveHandover = async (req, res, next) => {
  try {
    const doc = await YCHandover.findById(req.params.id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Handover not found" });
    }
    const answer = String(req.body?.answer || "").trim().slice(0, 2000);
    if (!answer) {
      return res
        .status(400)
        .json({ success: false, message: "answer is required" });
    }
    doc.answer = answer;
    doc.status = "resolved";
    doc.resolvedBy = req.user._id;
    doc.resolvedAt = new Date();
    let faq = null;
    if (req.body?.promoteToFaq) {
      faq = await YCFaq.create({ question: doc.question, answer });
      doc.promotedToFaq = true;
    }
    await doc.save();
    res.status(200).json({ success: true, handover: doc, faq });
  } catch (error) {
    next(error);
  }
};

module.exports = { CreateHandover, ListHandovers, ResolveHandover };
