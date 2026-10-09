/**
 * CAMP-Backend smoke test (no database required).
 *
 * Loads every module to confirm there are no syntax errors, missing
 * requires or circular dependencies, then asserts the CAMP
 * isolation, idempotency and routing guarantees hold.
 *
 *   node Server/smokeTest.js
 */

require("dotenv").config();

const assert = require("assert");

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

// ── Modules load ──
check("Model/YCUser loads", () => require("../Model/YCUser"));
check("Model/YCPayment loads", () => require("../Model/YCPayment"));
check("Model/YCMealLog loads", () => require("../Model/YCMealLog"));
check("Model/YCSouvenir loads", () => require("../Model/YCSouvenir"));
check("utils/genYCJWT loads", () => require("../utils/genYCJWT"));
check("utils/sendYCMail loads", () => require("../utils/sendYCMail"));
check("Middleware/YCAuthMiddleware loads", () =>
  require("../Middleware/YCAuthMiddleware")
);
check("Middleware/YCErrorMiddleware loads", () =>
  require("../Middleware/YCErrorMiddleware")
);
check("Controllers/YCAuthController loads", () =>
  require("../Controllers/YCAuthController")
);
check("Controllers/YCPaymentController loads", () =>
  require("../Controllers/YCPaymentController")
);
check("Controllers/YCAdminController loads", () =>
  require("../Controllers/YCAdminController")
);
check("Controllers/YCGiveawayController loads", () =>
  require("../Controllers/YCGiveawayController")
);
check("Routes/YCUserRoute loads", () => require("../Routes/YCUserRoute"));
check("Routes/YCPaymentRoute loads", () =>
  require("../Routes/YCPaymentRoute")
);
check("Routes/YCAdminRoute loads", () => require("../Routes/YCAdminRoute"));

// ── CAMP is isolated from GLS ──
check("No GLS model is registered by CAMP-Backend", () => {
  const mongoose = require("mongoose");

  const models = mongoose.modelNames();

  ["User", "Users", "PaymentCol", "PayRecords", "YCampers"].forEach((gls) => {
    assert.ok(
      !models.includes(gls),
      `GLS model "${gls}" leaked into CAMP-Backend`
    );
  });
});

check("CAMP models register under YC* names", () => {
  const mongoose = require("mongoose");

  ["YCUser", "YCPayment", "YCMealLog", "YCSouvenir"].forEach((name) => {
    assert.ok(
      mongoose.modelNames().includes(name),
      `missing CAMP model "${name}"`
    );
  });
});

// ── CAMP JWT isolation ──
check("CAMP JWT carries app=CAMP and rejects foreign signatures", () => {
  const jwt = require("jsonwebtoken");
  const genYCJWT = require("../utils/genYCJWT");

  process.env.CAMP_JWT_SECRET =
    process.env.CAMP_JWT_SECRET || "test-secret";

  const token = genYCJWT("507f1f77bcf86cd799439011", "user");
  const decoded = jwt.verify(token, process.env.CAMP_JWT_SECRET);

  assert.strictEqual(decoded.app, "CAMP");
  assert.strictEqual(decoded.role, "user");
  assert.strictEqual(decoded.id, "507f1f77bcf86cd799439011");

  // A token signed with the GLS secret must NOT verify against CAMP.
  const glsStyle = jwt.sign(
    { id: "x", type: "gls" },
    "gls-backend-secret"
  );

  assert.throws(
    () => jwt.verify(glsStyle, process.env.CAMP_JWT_SECRET),
    "a GLS-signed token must not verify against CAMP"
  );
});

// ── Collection isolation ──
check("CAMP collections are yc* namespaced", () => {
  const names = [
    require("../Model/YCUser").collection.name,
    require("../Model/YCPayment").collection.name,
    require("../Model/YCMealLog").collection.name,
    require("../Model/YCSouvenir").collection.name,
  ];

  names.forEach((n) => {
    assert.ok(
      n.toLowerCase().startsWith("yc"),
      `collection "${n}" is not CAMP-namespaced`
    );
  });

  assert.ok(!names.includes("users"), "CAMP must not use GLS 'users'");
  assert.ok(
    !names.includes("payrecords"),
    "CAMP must not use GLS 'payrecords'"
  );
});

// ── Idempotency guarantees ──
check("YCPayment uniquely indexes transactionId and reference", () => {
  const indexes = require("../Model/YCPayment").schema.indexes();

  const unique = indexes
    .filter(([, opts]) => opts && opts.unique)
    .map(([fields]) => Object.keys(fields));

  assert.ok(
    unique.some((f) => f.includes("transactionId")),
    "transactionId must be uniquely indexed"
  );
  assert.ok(
    unique.some((f) => f.includes("reference")),
    "reference must be uniquely indexed"
  );
});

check("YCMealLog blocks duplicate camper+meal+day", () => {
  const indexes = require("../Model/YCMealLog").schema.indexes();

  const found = indexes.some(
    ([fields, opts]) =>
      opts &&
      opts.unique &&
      fields.camperId === 1 &&
      fields.meal_type === 1 &&
      fields.day === 1
  );

  assert.ok(found, "compound unique index missing on meal logs");
});

check("YCSouvenir allows only one souvenir per camper", () => {
  const fields = require("../Model/YCSouvenir").schema.obj.camperId;

  assert.strictEqual(fields.unique, true, "camperId must be unique");
});

// ── CAMP business rules ──
check("CAMP target fee is 5000", () => {
  assert.strictEqual(Number(process.env.CAMP_TARGET_FEE || 5000), 5000);
});

// ── Route registration ──
check("Routes register the expected CAMP endpoints", () => {
  const express = require("express");

  const app = express();
  app.use(express.json());

  app.use("/api/ycuser", require("../Routes/YCUserRoute"));
  app.use("/api/ycpayment", require("../Routes/YCPaymentRoute"));
  app.use("/api/ycadmin", require("../Routes/YCAdminRoute"));

  const routes = [];

  // Express 5 exposes `app.router`; Express 4 used `app._router`.
  const router = app.router || app._router;
  const stack = (router && router.stack) || [];

  // A mounted sub-router is a layer WITHOUT `.route` but WITH
  // `.handle.stack`, so the walk must descend into it.
  const walk = (layers, prefix = "") => {
    layers.forEach((layer) => {
      if (layer.route) {
        Object.keys(layer.route.methods).forEach((method) => {
          routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
        });
        return;
      }

      const nested = layer.handle && layer.handle.stack;

      if (Array.isArray(nested)) {
        walk(nested, prefix);
      }
    });
  };

  walk(stack);

  const required = [
    "POST /signup",
    "POST /login",
    "POST /forgot-password",
    "POST /reset-password/:token",
    "GET /me",
    "POST /initiate",
    "POST /verify",
    "POST /webhook",
    "POST /giveaway/resolve",
    "POST /giveaway/transfer",
    "GET /campers",
    "GET /payments",
    "GET /meal-logs",
    "GET /souvenirs",
    "POST /meal-scan",
    "POST /souvenir-scan",
    "PATCH /campers/:id/role",
  ];

  required.forEach((r) => {
    assert.ok(routes.includes(r), `missing route: ${r}`);
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);

process.exit(failed === 0 ? 0 : 1);