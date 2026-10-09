// CAMP-Backend/Server/seedFaq.js
// Seeds `faq_knowledgeBase.md` (canonical file) into the YCFaq collection.
// Run:  npm run seed:faq   (from CAMP-Backend)
// Existing questions are matched case-insensitively and UPDATED, never duplicated.
// Uses one bulkWrite instead of per-doc round-trips (fast against remote Atlas),
// plus a watchdog so the process can never hang.
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const YCFaq = require("../Model/YCFaq");

const mdPath = path.join(__dirname, "../faq_knowledgeBase.md");

// Watchdog: force-exit if anything blocks for more than 90s.
const watchdog = setTimeout(() => {
  console.error("[seed:faq] watchdog fired — forcing exit");
  process.exit(2);
}, 90000);
watchdog.unref();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parse = (md) => {
  const lines = md.split(/\r?\n/);
  let category = "general";
  let question = "";
  let buf = [];
  const out = [];
  const flush = () => {
    if (question && buf.join("\n").trim()) {
      out.push({
        question: question.trim(),
        answer: buf.join("\n").trim(),
        category,
      });
    }
    question = "";
    buf = [];
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+\d+\.\s*(.+)/);
    if (h2) {
      flush();
      category = h2[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      continue;
    }
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      flush();
      question = h3[1].trim();
      continue;
    }
    if (question) buf.push(line);
  }
  flush();
  return out;
};

(async () => {
  const mongo = process.env.CAMP_MONGO_URL;
  if (!mongo) {
    console.error("[seed:faq] CAMP_MONGO_URL is missing in CAMP-Backend/.env");
    process.exit(1);
  }

  const md = fs.readFileSync(mdPath, "utf-8");
  const entries = parse(md);
  console.log(`[seed:faq] parsed ${entries.length} entries from markdown`);

  await mongoose.connect(mongo, {
    dbName: process.env.CAMP_MONGO_DB || undefined,
    serverSelectionTimeoutMS: 15000,
  });
  console.log("[seed:faq] connected to MongoDB");

  // One query: fetch every existing question (case-insensitive exact match set).
  const existing = await YCFaq.find({}).select("question").lean();
  const byLower = new Map(existing.map((d) => [d.question.trim().toLowerCase(), d]));

  const ops = [];
  let created = 0;
  let updated = 0;
  for (const e of entries) {
    const key = e.question.trim().toLowerCase();
    const hit = byLower.get(key);
    if (hit) {
      ops.push({
        updateOne: {
          filter: { _id: hit._id },
          update: { $set: { answer: e.answer, category: e.category, active: true } },
        },
      });
      updated += 1;
    } else {
      ops.push({
        insertOne: { document: { question: e.question, answer: e.answer, category: e.category, active: true } },
      });
      created += 1;
    }
  }

  if (ops.length) {
    await YCFaq.bulkWrite(ops, { ordered: false });
  }

  const total = await YCFaq.countDocuments();
  console.log(`[seed:faq] done — created ${created}, updated ${updated}, parsed ${entries.length}, collection total ${total}`);

  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(0);
})().catch((e) => {
  console.error("[seed:faq] failed:", e && e.message ? e.message : e);
  process.exit(1);
});
