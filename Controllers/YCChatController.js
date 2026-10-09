// CAMP-Backend/Controllers/YCChatController.js
// Owns: chat persistence, conversation context for the AI agent, and the
//       daily AI usage limit (guests 10/day, logged-in campers 15/day,
//       admins 25/day). Enforcement lives HERE — the single source of
//       truth — so no client or agent change can bypass it.
const YCChatMessage = require("../Model/YCChatMessage");

const GUEST_LIMIT = Number(process.env.CAMP_AI_GUEST_LIMIT) || 10;
const MEMBER_LIMIT = Number(process.env.CAMP_AI_DAILY_LIMIT) || 15;
const ADMIN_LIMIT = Number(process.env.CAMP_AI_ADMIN_LIMIT) || 25;

const limitFor = (req) =>
  req.user
    ? req.user.role === "admin"
      ? ADMIN_LIMIT
      : MEMBER_LIMIT
    : GUEST_LIMIT;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Logged-in users are scoped by userId; guests by an IP-derived id.
const scopeFilter = (req, guestId) => {
  if (req.user) return { userId: req.user._id };
  const gid = String(guestId || req.ip || "unknown").slice(0, 128);
  return { guestId: gid };
};

const countToday = (filter) =>
  YCChatMessage.countDocuments({
    ...filter,
    role: "user",
    date: { $gte: startOfToday() },
  });

// ─────────────────────────────────────────────────────────────
// POST /api/ychat/log
// Persists one message. When the message is from the user it ALSO
// enforces the daily quota (429 before the LLM ever runs).
// Admins bypass the quota entirely.
// ─────────────────────────────────────────────────────────────

const LogChatMessage = async (req, res, next) => {
  try {
    const role = req.body?.role;
    const content = String(req.body?.content || "").trim();
    const guestId = req.body?.guestId;

    if (role !== "user" && role !== "assistant") {
      return res
        .status(400)
        .json({ success: false, message: "role must be 'user' or 'assistant'" });
    }
    if (!content || content.length > 4000) {
      return res
        .status(400)
        .json({ success: false, message: "content is required (max 4000 chars)" });
    }

    const filter = scopeFilter(req, guestId);
    let remaining = null;

    if (role === "user") {
      const limit = limitFor(req);
      if (limit !== null) {
        const used = await countToday(filter);
        if (used >= limit) {
          return res.status(429).json({
            success: false,
            remaining: 0,
            usedToday: used,
            dailyLimit: limit,
            tier: req.user ? "member" : "guest",
            unlimited: false,
            message:
              `You've used all ${limit} messages allowed for today. ` +
              "Please try again tomorrow.",
          });
        }
        remaining = limit - used - 1;
      }
    }

    await YCChatMessage.create({
      userId: req.user ? req.user._id : null,
      guestId: req.user ? null : String(guestId || req.ip || "unknown").slice(0, 128),
      role,
      content,
    });

    const limit = limitFor(req);
    res.status(201).json({
      success: true,
      remaining,
      usedToday: null, // cheap path: caller reads exact counts from /context
      dailyLimit: limit,
      unlimited: false,
      tier: !req.user ? "guest" : req.user.role === "admin" ? "admin" : "member",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/ychat/context?guestId=…
// Recent conversation for THIS caller (newest first, returned in
// chronological order) — the agent injects it as prior context so
// replies can be personal ("Hi Emmanuel…").
// ─────────────────────────────────────────────────────────────

const GetChatContext = async (req, res, next) => {
  try {
    const filter = scopeFilter(req, req.query.guestId);
    const rows = await YCChatMessage.find(filter)
      .sort({ date: -1, _id: -1 })
      .limit(30)
      .select("role content date")
      .lean();

    rows.reverse();

    const used = await countToday(filter);
    const limit = limitFor(req);

    res.status(200).json({
      success: true,
      messages: rows.map((m) => ({ role: m.role, content: m.content })),
      usedToday: used,
      dailyLimit: limit,
      remaining: Math.max(limit - used, 0),
      unlimited: false,
      tier: !req.user ? "guest" : req.user.role === "admin" ? "admin" : "member",
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/ychat/history  (auth) — own chat history
// GET /api/ychat/user/:userId (admin) — any camper's chat history,
// so admins can see a camper's stated payment intentions.
// ─────────────────────────────────────────────────────────────

const GetChatHistory = async (req, res, next) => {
  try {
    const rows = await YCChatMessage.find({ userId: req.user._id })
      .sort({ date: -1, _id: -1 })
      .limit(100)
      .select("role content date")
      .lean();

    rows.reverse();
    res.status(200).json({ success: true, messages: rows });
  } catch (error) {
    next(error);
  }
};

const GetUserChat = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const rows = await YCChatMessage.find({ userId })
      .sort({ date: -1, _id: -1 })
      .limit(20)
      .select("role content date")
      .lean();

    rows.reverse();
    res.status(200).json({ success: true, messages: rows });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  LogChatMessage,
  GetChatContext,
  GetChatHistory,
  GetUserChat,
};
