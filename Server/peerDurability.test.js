/**
 * CAMP-Backend/Server/peerDurability.test.js
 *
 * PEER-TO-PEER DURABILITY TEST (database-backed, end-to-end).
 *
 * Scenario — executed with the REAL offline-admin client code:
 *
 *   1. Device A records a meal while OFFLINE (ops.buildOperation — the
 *      exact operation Device A's UI would create).
 *   2. Device A shares it with Device B over the peer protocol
 *      (peer.applyIncomingOperation — the exact call PeerPage makes when
 *      a peer's operation arrives).
 *   3. Device A then DISAPPEARS before it ever syncs.
 *   4. Device B must keep the meal locally AND queue the operation as
 *      PENDING in its outbox (so it forwards it to the backend later).
 *   5. Internet returns; Device B uploads it with the REAL uploader
 *      (sync.pushPendingOperations → the existing single-op endpoints,
 *      which is the default path when ENABLE_OFFLINE_SYNC=false).
 *   6. MongoDB must receive the operation EXACTLY ONCE, despite:
 *        • duplicate peer delivery, and
 *        • a sync retry (an upload whose ack was never persisted).
 *
 * The client modules are run under Node via:
 *   • an in-memory IndexedDB shim (db.js uses the native IndexedDB API),
 *   • a localStorage shim (backend.js reads the bearer token), and
 *   • importMetaEnvLoader.mjs (shims import.meta.env for Vite-only code).
 *
 * It runs against an ISOLATED local MongoDB database (default
 * `ubc_camp_peer_test`) that is dropped before and after the run, and it
 * refuses any database name that does not contain "test", so it can never
 * touch production data.
 *
 * Usage:
 *   node Server/peerDurability.test.js
 *   CAMP_TEST_MONGO_URL=mongodb://127.0.0.1:27017/mycamp_test node Server/peerDurability.test.js
 *
 * If no MongoDB is reachable the test SKIPS (exit 0) with a clear note.
 */

const assert = require("assert");
const http = require("http");
const path = require("path");
const express = require("express");
const { pathToFileURL } = require("url");
const { register } = require("node:module");

const TEST_URI =
  process.env.CAMP_TEST_MONGO_URL ||
  "mongodb://127.0.0.1:27017/ubc_camp_peer_test";

// Must be set before anything signs/verifies a token.
process.env.CAMP_JWT_SECRET = process.env.CAMP_JWT_SECRET || "camp-test-secret";

// ── safety guard: never point this at a production database ──
function dbNameOf(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "mongodb://"));
    return (u.pathname || "").replace(/^\//, "");
  } catch {
    return "";
  }
}
const DB_NAME = dbNameOf(TEST_URI);
if (!/test/i.test(DB_NAME)) {
  console.error(
    `\nRefusing to run: test database name "${DB_NAME}" does not contain "test".\n` +
      `Set CAMP_TEST_MONGO_URL to an isolated *test* database.\n`
  );
  process.exit(2);
}

// ── an in-memory IndexedDB good enough for db.js ─────────────
// Implements exactly the surface offline-admin/src/lib/db.js uses:
// open/upgrade, object stores with a keyPath, secondary indexes,
// put/add/get/getAll/delete/clear/count and transactions with oncomplete.
function installIndexedDBShim() {
  if (globalThis.indexedDB) return;

  const newRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });
  const fulfill = (req, value) => {
    req.result = value;
    queueMicrotask(() => {
      if (typeof req.onsuccess === "function") req.onsuccess.call(req, { target: req });
    });
    return req;
  };
  const reject = (req, error) => {
    req.error = error;
    queueMicrotask(() => {
      if (typeof req.onerror === "function") req.onerror.call(req, { target: req });
    });
    return req;
  };
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));

  class FIndex {
    constructor(store, name, keyPath) {
      this.store = store;
      this.name = name;
      this.keyPath = keyPath;
    }
    matches(query) {
      const all = [...this.store.data.values()];
      if (query === undefined || query === null) return all;
      return all.filter((v) => v != null && v[this.keyPath] === query);
    }
    get(query) {
      return fulfill(newRequest(), copy(this.matches(query)[0]));
    }
    getAll(query) {
      return fulfill(newRequest(), this.matches(query).map(copy));
    }
    count(query) {
      return fulfill(newRequest(), this.matches(query).length);
    }
  }

  class FStore {
    constructor(name, keyPath) {
      this.name = name;
      this.keyPath = keyPath || null;
      this.data = new Map();
      this.indexes = new Map();
    }
    keyOf(value) {
      return this.keyPath ? value[this.keyPath] : undefined;
    }
    createIndex(name, keyPath) {
      const idx = new FIndex(this, name, keyPath);
      this.indexes.set(name, idx);
      return idx;
    }
    index(name) {
      const idx = this.indexes.get(name);
      if (!idx) throw new Error(`NotFoundError: no index "${name}"`);
      return idx;
    }
  }

  class FTx {
    constructor(db, names, mode) {
      this.db = db;
      this.mode = mode;
      this.objectStoreNames = names;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this._timer = null;
      this._done = false;
    }
    // A transaction completes once no new request is issued for a full
    // macrotask — mirrors IndexedDB's auto-commit well enough for db.js.
    _touch() {
      if (this._done) return;
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._done = true;
        if (typeof this.oncomplete === "function") this.oncomplete.call(this, { target: this });
      }, 0);
    }
    objectStore(name) {
      const store = this.db._stores.get(name);
      if (!store) throw new Error(`NotFoundError: no object store "${name}"`);
      return makeHandle(this, store);
    }
  }

  function makeHandle(tx, store) {
    return {
      put: (value, key) => {
        tx._touch();
        const k = key !== undefined ? key : store.keyOf(value);
        store.data.set(k, copy(value));
        return fulfill(newRequest(), k);
      },
      add: (value, key) => {
        tx._touch();
        const k = key !== undefined ? key : store.keyOf(value);
        if (store.data.has(k)) return reject(newRequest(), new Error("ConstraintError: key exists"));
        store.data.set(k, copy(value));
        return fulfill(newRequest(), k);
      },
      get: (key) => {
        tx._touch();
        return fulfill(newRequest(), copy(store.data.get(key)));
      },
      delete: (key) => {
        tx._touch();
        store.data.delete(key);
        return fulfill(newRequest(), undefined);
      },
      getAll: (query) => {
        tx._touch();
        let all = [...store.data.values()];
        if (query !== undefined && query !== null) {
          all = all.filter((v) => store.keyOf(v) === query);
        }
        return fulfill(newRequest(), all.map(copy));
      },
      clear: () => {
        tx._touch();
        store.data.clear();
        return fulfill(newRequest(), undefined);
      },
      count: () => {
        tx._touch();
        return fulfill(newRequest(), store.data.size);
      },
      index: (name) => makeIndexHandle(tx, store.index(name)),
    };
  }

  function makeIndexHandle(tx, index) {
    return {
      get: (query) => {
        tx._touch();
        return fulfill(newRequest(), copy(index.matches(query)[0]));
      },
      getAll: (query) => {
        tx._touch();
        return fulfill(newRequest(), index.matches(query).map(copy));
      },
      count: (query) => {
        tx._touch();
        return fulfill(newRequest(), index.matches(query).length);
      },
    };
  }

  class FDB {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this._stores = new Map();
    }
    get objectStoreNames() {
      const names = [...this._stores.keys()];
      return { contains: (n) => names.includes(n), length: names.length, item: (i) => names[i] };
    }
    createObjectStore(name, opts) {
      const s = new FStore(name, opts && opts.keyPath);
      this._stores.set(name, s);
      return s;
    }
    transaction(names, mode) {
      return new FTx(this, Array.isArray(names) ? names : [names], mode);
    }
  }

  const databases = new Map();
  globalThis.indexedDB = {
    open(name, version) {
      const req = newRequest();
      setTimeout(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) {
          db = new FDB(name, version || 1);
          databases.set(name, db);
        }
        req.result = db;
        if (fresh && typeof req.onupgradeneeded === "function") {
          req.onupgradeneeded.call(req, { target: req });
        }
        if (typeof req.onsuccess === "function") req.onsuccess.call(req, { target: req });
      }, 0);
      return req;
    },
    deleteDatabase(name) {
      const req = newRequest();
      setTimeout(() => {
        databases.delete(name);
        if (typeof req.onsuccess === "function") req.onsuccess.call(req, { target: req });
      }, 0);
      return req;
    },
  };
}

// ── tiny result tracker ──────────────────────────────────────
let passed = 0;
let failed = 0;
function ok(name) {
  console.log(`✅ ${name}`);
  passed++;
}
function bad(name, error) {
  console.error(`❌ ${name}\n   ${error.message}`);
  failed++;
}
async function step(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    bad(name, error);
  }
}
const note = (...a) => console.log("   ", ...a);

// ── the scenario ─────────────────────────────────────────────
(async () => {
  const mongoose = require("mongoose");
  try {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 4000 });
  } catch (error) {
    console.log(
      `\nSKIP: no MongoDB reachable at ${TEST_URI}\n     (${error.message})\n` +
        `Set CAMP_TEST_MONGO_URL to run the database-backed durability test.\n`
    );
    process.exitCode = 0;
    return;
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(" UBC CAMP — peer-to-peer durability test");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`Using isolated test database: ${DB_NAME}\n`);

  const YCUser = require("../Model/YCUser");
  const YCMealLog = require("../Model/YCMealLog");
  const YCAdminRoute = require("../Routes/YCAdminRoute");
  const genYCJWT = require("../utils/genYCJWT");
  const errorMiddleware = require("../Middleware/YCErrorMiddleware");

  try {
    await mongoose.connection.dropDatabase();
    await Promise.all([YCUser.syncIndexes(), YCMealLog.syncIndexes()]);

    const admin = await YCUser.create({
      email: "peer-durability-admin@test.local",
      name: "Peer Durability Admin",
      role: "admin",
      amount_paid: 5000,
    });
    const camper = await YCUser.create({
      email: "peer-durability-camper@test.local",
      name: "Peer Durability Camper",
      team: "KETER",
      role: "user",
      amount_paid: 5000,
    });
    const camperId = String(camper._id);
    const token = genYCJWT(String(admin._id), "admin");

    // Backend mirrors the DEFAULT deployment: ENABLE_OFFLINE_SYNC=false,
    // so /api/admin/sync/push is NOT mounted and 404s → the client falls
    // back to the existing single-operation endpoints.
    const app = express();
    app.use(express.json());
    app.use("/api/admin", YCAdminRoute);
    app.use("/api", (req, res) => {
      res.status(404).json({ success: false, message: `route not found: ${req.method} ${req.originalUrl}` });
    });
    app.use(errorMiddleware);
    const server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;

    // ── wire the client modules (REAL code) under Node ──
    installIndexedDBShim();
    globalThis.localStorage = {
      _s: {},
      getItem(k) { return k in this._s ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    };
    globalThis.localStorage.setItem("token", token);
    globalThis.__VITE_ENV__ = {
      VITE_CAMP_API_URL: base, // used by backend.js (import.meta.env)
      VITE_CAMP_TARGET_FEE: "5000", // used by camp.js (import.meta.env)
    };
    register(pathToFileURL(path.join(__dirname, "importMetaEnvLoader.mjs")).href);

    const libDir = path.join(__dirname, "..", "..", "offline-admin", "src", "lib");
    const importLib = (file) => import(pathToFileURL(path.join(libDir, file)).href);
    const ops = await importLib("ops.js");
    const db = await importLib("db.js");
    const peer = await importLib("peer.js");
    const sync = await importLib("sync.js");

    // A fresh, empty device.
    await db.getDB();

    const DAY = "2026-05-01";
    let opA = null;

    try {
      // ── 1. Device A records the meal offline ──
      await step("Device A: records a 'Breakfast' meal for the camper while offline", async () => {
        opA = await ops.buildOperation({
          type: ops.OP_TYPE.MEAL,
          camperId,
          payload: { mealType: "Breakfast", day: DAY, camperName: camper.name },
        });
        assert.ok(opA.opId, "operation must carry an opId");
        assert.strictEqual(opA.dedupeKey, `meal:${camperId}:Breakfast:${DAY}`);
        note(`opId=${opA.opId}`);
        note("Device A now disappears — it never reaches the backend.");
      });

      // ── 2. Device B receives the operation from Device A ──
      await step("Device B: applying A's operation returns true and stores the meal", async () => {
        const applied = await peer.applyIncomingOperation(opA);
        assert.strictEqual(applied, true, "a brand-new peer operation must apply");

        const meal = await db.findMealLog(opA.dedupeKey);
        assert.ok(meal, "B must keep a local copy of the meal");
        assert.strictEqual(String(meal.camperId), camperId);
        assert.strictEqual(meal.syncState, "local", "not server-confirmed yet");
      });

      // ── 3. THE DURABILITY FIX: B queues it as PENDING for the backend ──
      await step("Device B: queues the received operation as PENDING in its outbox", async () => {
        const pending = await db.outboxPending();
        const queued = pending.find((o) => o.opId === opA.opId);
        assert.ok(queued, "the peer operation must be queued for backend upload");
        assert.strictEqual(queued.status, "pending");
        assert.strictEqual(queued.source, "peer");
        assert.strictEqual(queued.dedupeKey, opA.dedupeKey);
      });

      // ── 4. Duplicate peer delivery is idempotent ──
      await step("Device B: a duplicate peer delivery adds no second meal or outbox row", async () => {
        const appliedAgain = await peer.applyIncomingOperation(opA);
        assert.strictEqual(appliedAgain, false, "a duplicate delivery must be a no-op");

        const meals = await db.getAllMealLogs();
        assert.strictEqual(meals.length, 1, "exactly one local meal");
        const all = await db.outboxAll();
        assert.strictEqual(all.filter((o) => o.opId === opA.opId).length, 1, "exactly one outbox row");
      });

      // ── 5. Internet returns: B uploads via the REAL uploader ──
      await step("Device B: pushPendingOperations uploads the operation (fallback path)", async () => {
        const res = await sync.pushPendingOperations();
        assert.strictEqual(res.synced, 1, "the queued operation must be acknowledged");
        assert.deepStrictEqual(res.conflicts || [], [], "no conflicts");

        const row = await db.outboxGet(opA.opId);
        assert.strictEqual(row.status, "synced", "outbox row must flip to synced");
        const meal = await db.findMealLog(opA.dedupeKey);
        assert.strictEqual(meal.syncState, "synced", "projection must flip to synced");
      });

      await step("MongoDB received the meal exactly once", async () => {
        const count = await YCMealLog.countDocuments({ camperId: camper._id, meal_type: "Breakfast" });
        assert.strictEqual(count, 1, "exactly one meal in MongoDB");
      });

      // ── 6. A sync RETRY (ack lost) must not duplicate ──
      await step("Device B: a sync retry (lost ack) still yields exactly one meal in MongoDB", async () => {
        // Simulate a device that uploaded but crashed before persisting
        // the acknowledgement, so the operation is retried.
        await db.outboxUpdate(opA.opId, { status: "pending" });
        const res = await sync.pushPendingOperations();
        assert.strictEqual(res.synced, 1, "the retry must be acknowledged (409 = already recorded)");

        const count = await YCMealLog.countDocuments({ camperId: camper._id, meal_type: "Breakfast" });
        assert.strictEqual(count, 1, "the retry must not create a second meal");
      });

      // ── 7. A late duplicate delivery cannot resurrect a completed op ──
      await step("Device B: a late duplicate delivery does not re-queue a synced operation", async () => {
        const appliedAgain = await peer.applyIncomingOperation(opA);
        assert.strictEqual(appliedAgain, false);
        const row = await db.outboxGet(opA.opId);
        assert.strictEqual(row.status, "synced", "a completed upload must not be resurrected");

        const res = await sync.pushPendingOperations();
        assert.strictEqual(res.pushed, 0, "nothing should remain pending");
        const count = await YCMealLog.countDocuments({ camperId: camper._id, meal_type: "Breakfast" });
        assert.strictEqual(count, 1, "still exactly one meal in MongoDB");
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } catch (error) {
    console.error("peerDurability.test crashed:", error);
    failed++;
  } finally {
    try {
      await mongoose.connection.dropDatabase();
    } catch {
      /* ignore */
    }
    await mongoose.disconnect();
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(` ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");
  process.exitCode = failed === 0 ? 0 : 1;
})();
