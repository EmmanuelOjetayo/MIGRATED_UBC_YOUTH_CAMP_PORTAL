require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const hpp = require("hpp");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const dns = require("dns");

const DB_Connect = require("../config/db.js");
const errorMiddleware = require("../Middleware/YCErrorMiddleware.js");

const YCUserRoute = require("../Routes/YCUserRoute.js");
const YCPaymentRoute = require("../Routes/YCPaymentRoute.js");
const YCAdminRoute = require("../Routes/YCAdminRoute.js");
const YCExpenseRoute = require("../Routes/YCExpenseRoute.js");
const YCChatRoute = require("../Routes/YCChatRoute.js");
const YCFaqRoute = require("../Routes/YCFaqRoute.js");
const YCReminderRoute = require("../Routes/YCReminderRoute.js");

const app = express();

// ============================
// DNS CONFIGURATION
// ============================
// Atlas uses SRV lookup, which the default resolver can fail to answer.
// Override only when the operator explicitly configures DNS servers.
if (process.env.CAMP_DNS_SERVERS) {
  const servers = process.env.CAMP_DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean);
  if (servers.length) {
    dns.setDefaultResultOrder("ipv4first");
    dns.setServers(servers);
  }
}

// ============================
// BASIC CONFIG
// ============================

const PORT = process.env.PORT || 5050;

app.disable("x-powered-by");
app.set("trust proxy", 1);

// ============================
// SECURITY
// ============================

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(compression());

app.use(hpp());

// Only trusted CAMP frontend origins are accepted. Dev origin is always
// included; extra origins (staging/production) come from the environment:
//   CAMP_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
//   CAMP_CLIENT_URL=https://app.example.com        (single legacy alias)
const allowedOrigins = [
  "http://localhost:5173",
  ...(process.env.CAMP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim()),
  process.env.CAMP_CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

// ============================
// LOGGER
// ============================

app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev")
);

// ============================
// RATE LIMITER
// ============================

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 Minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again after 5 minutes.",
  },
});

app.use("/api", limiter);

// ============================
// HEALTH CHECK
// ============================

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "OK",
    application: "CAMP",
    uptime: process.uptime(),
    timestamp: new Date(),
    environment: process.env.NODE_ENV,
  });
});

// ============================
// ROUTES
//
// CAMP mounts its own namespace (`/api/yc*`) AND keeps the
// short aliases the existing CAMP frontend already calls
// (`/api/user`, `/api/payment`, `/api/admin`).
// ============================

// CAMP namespace (canonical)
app.use("/api/ycuser", YCUserRoute);
app.use("/api/ycpayment", YCPaymentRoute);
app.use("/api/ycadmin", YCAdminRoute);
// Expenses + financial summary (consumed by the camp-agent admin tools).
// Mounted after YCAdminRoute: it owns /expenses and /reports/financial-summary.
app.use("/api/ycadmin", YCExpenseRoute);

// AI agent support: chat persistence/quota + admin-managed FAQ.
// `/api/faq` public GET is the agent's live knowledge base.
app.use("/api/ychat", YCChatRoute);
app.use("/api/faq", YCFaqRoute);

// Payment intentions + reminders (agent + camper share intent;
// admins review reminders before they go out).
app.use("/api/ycadmin/reminders", YCReminderRoute);

// Expense approval + financial summary.
app.use("/api/ycadmin/expenses", YCExpenseRoute);

// Frontend-facing aliases
app.use("/api/user", YCUserRoute);
app.use("/api/payment", YCPaymentRoute);
app.use("/api/admin", YCAdminRoute);
app.use("/api/admin", YCExpenseRoute);

// Logout is a client-side token discard; the endpoint exists so the
// CAMP admin UI can call it without erroring.
app.post("/api/auth/logout", (req, res) => {
  res.status(200).json({ success: true, message: "Logged out" });
});

// ============================
// 404 HANDLER
// ============================

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: `CAMP API route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ============================
// ERROR HANDLER
// ============================

app.use(errorMiddleware);

// ============================
// DATABASE + SERVER START
// ============================

let server;

async function start() {
  try {
    await DB_Connect();
  } catch (error) {
    console.error("CAMP Database connection failed:", error.message);
    process.exit(1);
  }

  server = app.listen(PORT, () => {
    console.log(`CAMP Backend running on port ${PORT}`);
  });
}

start();

// ============================
// PROCESS EVENTS
// ============================

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  // Continuing after an uncaught exception can leave the process in an
  // undefined state. Shut down cleanly and let the process manager restart.
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("SIGINT", () => {
  console.log("CAMP Server shutting down...");
  if (server) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

process.on("SIGTERM", () => {
  console.log("CAMP Server terminated.");
  if (server) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});
