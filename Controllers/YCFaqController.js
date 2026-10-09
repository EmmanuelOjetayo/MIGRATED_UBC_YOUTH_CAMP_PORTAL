// CAMP-Backend/Controllers/YCFaqController.js
// Admin-managed FAQ that the camp-agent reads live on every turn.
const YCFaq = require("../Model/YCFaq");

const sanitize = (req) => {
  const question = String(req.body?.question || "").trim();
  const answer = String(req.body?.answer || "").trim();
  const category = String(req.body?.category || "general").trim().slice(0, 60) || "general";
  return { question, answer, category };
};

// Public: only active entries, in display order (used by the agent).
const GetFaqs = async (req, res, next) => {
  try {
    const filter = { active: true };
    if (req.query.category) filter.category = String(req.query.category);
    const faqs = await YCFaq.find(filter)
      .sort({ sortOrder: 1, createdAt: 1 })
      .select("question answer category")
      .lean();

    res.status(200).json({ success: true, faqs });
  } catch (error) {
    next(error);
  }
};

// Admin: everything, including inactive entries.
const ListFaqs = async (req, res, next) => {
  try {
    const faqs = await YCFaq.find({})
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    res.status(200).json({ success: true, count: faqs.length, faqs });
  } catch (error) {
    next(error);
  }
};

const CreateFaq = async (req, res, next) => {
  try {
    const { question, answer, category } = sanitize(req);
    if (!question || !answer) {
      return res
        .status(400)
        .json({ success: false, message: "Both question and answer are required" });
    }

    // Prevent near-duplicate questions (case-insensitive exact match).
    const dupe = await YCFaq.findOne({
      question: { $regex: `^${question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (dupe) {
      return res.status(409).json({
        success: false,
        message: "A very similar question already exists in the knowledge base.",
        faq: dupe,
      });
    }

    const faq = await YCFaq.create({
      question,
      answer,
      category,
      active: req.body?.active !== false,
      sortOrder: Number(req.body?.sortOrder) || 0,
    });

    res.status(201).json({ success: true, message: "FAQ added", faq });
  } catch (error) {
    next(error);
  }
};

const UpdateFaq = async (req, res, next) => {
  try {
    const faq = await YCFaq.findById(req.params.id);
    if (!faq) {
      return res
        .status(404)
        .json({ success: false, message: "FAQ not found" });
    }

    const { question, answer, category } = sanitize(req);
    if (question) faq.question = question;
    if (answer) faq.answer = answer;
    if (category) faq.category = category;
    if (typeof req.body?.active === "boolean") faq.active = req.body.active;
    if (req.body?.sortOrder !== undefined) {
      faq.sortOrder = Number(req.body.sortOrder) || 0;
    }

    await faq.save();
    res.status(200).json({ success: true, message: "FAQ updated", faq });
  } catch (error) {
    next(error);
  }
};

const DeleteFaq = async (req, res, next) => {
  try {
    const faq = await YCFaq.findByIdAndDelete(req.params.id);
    if (!faq) {
      return res
        .status(404)
        .json({ success: false, message: "FAQ not found" });
    }

    res.status(200).json({ success: true, message: "FAQ deleted" });
  } catch (error) {
    next(error);
  }
};

module.exports = { GetFaqs, ListFaqs, CreateFaq, UpdateFaq, DeleteFaq };
