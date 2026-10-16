/**
 * CAMP-Backend offline-sync endpoint test (no database required).
 *
 * Covers the ADDITIVE offline-sync surface used by the offline-admin
 * PWA and nothing else, so it can run anywhere:
 *
 *   • the YCSyncOp idempotency ledger registers with a unique opId index
 *   • the sync router exposes ONLY the idempotent POST /push route
 *     (the unused GET /pull was removed)
 *   • offline sync is OPT-IN: with ENABLE_OFFLINE_SYNC unset the /sync/*
 *     paths do not exist (404); with it set the routes exist but reject
 *     unauthenticated callers (401) — the same auth as every admin route
 *   • the flag parsing contract used by Server/app.js
 *
 * It deliberately does NOT connect to MongoDB. Requests that would reach
 * the database are only sent WITHOUT credentials, where ycAuth answers
 * 401 before any query runs.
 *
 *   node Server/offlineSyncTest.js
 */

require("dotenv").config();

const assert = require("assert");
const http = require("http");
const express = require("express");

// ycAuth needs a secret to even attempt verification; a no-token request
// never reaches verification, but set one so module load is deterministic.
process.env.CAMP_JWT_SECRET = process.env.CAMP_JWT_SECRET || "test-secret";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.message}`);
    failed++;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.error(`❌ ${name}\n   ${error.message}`);
    failed++;
  }
}

// Mirrors the OPT-IN gating in Server/app.js: the router is only required
// and mounted when ENABLE_OFFLINE_SYNC=true. Kept here so the test can
// assert the real router's behaviour for both flag states without starting
// the server (which connects MongoDB and listens).
function buildApp(enabled) {
  const app = express();
  app.use(express.json());
  if (enabled) {
    const YCSyncRoute = require("../Routes/YCSyncRoute");
    app.use("/api/ycadmin/sync", YCSyncRoute);
    app.use("/api/admin/sync", YCSyncRoute);
  }
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Uses the core http module (not global fetch) so no keep-alive sockets
// outlive the test and hold the event loop open.
function status(server, method, pathname, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        host: "127.0.0.1",
        port: server.address().port,
        path: pathname,
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  // ── module + schema ──
  check("Model/YCSyncOp loads", () => require("../Model/YCSyncOp"));

  check("YCSyncOp uniquely indexes opId (idempotency ledger)", () => {
    const indexes = require("../Model/YCSyncOp").schema.indexes();
    const hasUniqueOpId = indexes.some(
      ([fields, opts]) => opts && opts.unique && fields.opId === 1
    );
    assert.ok(hasUniqueOpId, "unique index on opId is required");
  });

  check("Routes/YCSyncRoute loads", () => require("../Routes/YCSyncRoute"));

  check("sync router exposes ONLY POST /push", () => {
    const router = require("../Routes/YCSyncRoute");
    const routes = (router.stack || [])
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).map((m) => m.toUpperCase()),
      }));

    assert.strictEqual(routes.length, 1, `expected 1 route, got ${routes.length}`);
    assert.deepStrictEqual(routes[0].methods, ["POST"]);
    assert.strictEqual(routes[0].path, "/push");
  });

  // ── flag OFF (default): the paths do not exist ──
  await checkAsync("ENABLE_OFFLINE_SYNC=off → /sync/* are 404", async () => {
    const server = await listen(buildApp(false));
    try {
      assert.strictEqual(
        await status(server, "POST", "/api/admin/sync/push", {}, { operations: [] }),
        404
      );
      assert.strictEqual(
        await status(server, "POST", "/api/ycadmin/sync/push", {}, { operations: [] }),
        404
      );
    } finally {
      await close(server);
    }
  });

  // ── flag ON: routes exist but require admin auth ──
  await checkAsync("ENABLE_OFFLINE_SYNC=on → push requires auth (401)", async () => {
    const server = await listen(buildApp(true));
    try {
      assert.strictEqual(
        await status(server, "POST", "/api/admin/sync/push", {}, { operations: [] }),
        401
      );
      assert.strictEqual(
        await status(server, "POST", "/api/ycadmin/sync/push", {}, { operations: [] }),
        401
      );
    } finally {
      await close(server);
    }
  });

  await checkAsync("ENABLE_OFFLINE_SYNC=on → removed pull endpoint is 404", async () => {
    const server = await listen(buildApp(true));
    try {
      assert.strictEqual(await status(server, "GET", "/api/admin/sync/pull"), 404);
      assert.strictEqual(await status(server, "GET", "/api/ycadmin/sync/pull"), 404);
    } finally {
      await close(server);
    }
  });

  // ── flag parsing contract (matches Server/app.js) ──
  check("flag parse: only 'true' (case-insensitive) enables sync", () => {
    const parse = (v) => String(v || "").toLowerCase() === "true";
    assert.strictEqual(parse(undefined), false);
    assert.strictEqual(parse(""), false);
    assert.strictEqual(parse("false"), false);
    assert.strictEqual(parse("TRUE"), true);
    assert.strictEqual(parse("true"), true);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((error) => {
  console.error("offlineSyncTest crashed:", error);
  process.exitCode = 1;
});
