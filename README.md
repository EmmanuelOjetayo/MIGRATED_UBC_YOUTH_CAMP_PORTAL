# CAMP-Backend

**UBC Youth Camp (YC) backend** — an independent Express/MongoDB API that
owns every CAMP-specific function: authentication, JWT, payments,
logistics, meals, souvenirs, expenses, chat, FAQ, reminders and the
human-handover queue.

> **This is NOT the GLS backend.** The GLS backend lives in `../Backend`
> and is a separate, working application. CAMP-Backend imports **no** GLS
> files and shares **no** code with it.

---

## Architecture

```
CAMP (frontend)  ──▶  CAMP-Backend (this)  ──▶  MongoDB
                           │
                           └─ CAMP-owned collections only
```

CAMP reuses the **same MongoDB cluster** as the GLS backend, but writes
only to its own `yc*` collections. GLS collections are never read or
written from this service.

| CAMP model   | Mongo collection | Legacy Appwrite source |
|--------------|------------------|-------------------------|
| `YCUser`     | `ycusers`        | `campers`               |
| `YCPayment`  | `ycpayments`     | `payments`              |
| `YCMealLog`  | `ycmeallogs`     | `meallogs`              |
| `YCSouvenir` | `ycsouvenirs`    | `souvenirs`             |
| `YCExpense`  | `ycexpenses`     | —                       |
| `YCChatMessage` | `ycchatmessages` | —                    |
| `YCHandover` | `yhandovers`     | —                       |
| `YCFaq`      | `ycfaqs`         | —                       |
| `YCReminderLog` | `ycreminderlogs` | —                    |
| `YCPaymentIntention` | `ycpaymentintentions` | —             |

---

## Structure

```
CAMP-Backend/
├── Server/
│   ├── app.js                        Express bootstrap
│   ├── migrateAppwriteToCAMP.js      Legacy Appwrite → CAMP Mongo
│   ├── verifyMigration.js            Reconciliation report
│   ├── seedFaq.js                    Seed FAQ entries
│   ├── connectivity.js               DB connectivity check
│   └── smokeTest.js                  Isolation/idempotency tests
├── Controllers/                      YCAuth, YCPayment, YCAdmin, YCGiveaway,
│                                     YCChat, YCHandover, YCExpense, YCFaq,
│                                     YCReminder, YCIntention
├── Model/                            YCUser, YCPayment, YCMealLog, YCSouvenir,
│                                     YCExpense, YCChatMessage, YCHandover,
│                                     YCFaq, YCReminderLog, YCPaymentIntention
├── Routes/                           YCUserRoute, YCPaymentRoute, YCAdminRoute,
│                                     YCExpenseRoute, YCChatRoute, YCFaqRoute,
│                                     YCReminderRoute
├── Middleware/                       YCAuthMiddleware, YCErrorMiddleware
├── utils/                            genYCJWT, sendYCMail
└── config/                           db.js, campMongo.js
```

---

## Setup

```bash
npm install
cp .env.example .env     # then fill in the CAMP values
npm run dev              # http://localhost:5050
```

Health check: `GET http://localhost:5050/api/health`

---

## Endpoints

Mounted under the CAMP namespace **and** the short aliases the CAMP
frontend already calls.

### Auth

| Method | CAMP namespace | Alias | Auth |
|--------|----------------|-------|------|
| POST | `/api/ycuser/signup` | `/api/user/signup` | public |
| POST | `/api/ycuser/login` | `/api/user/login` | public |
| POST | `/api/ycuser/forgot-password` | `/api/user/forgot-password` | public |
| POST | `/api/ycuser/reset-password/:token` | `/api/user/reset-password/:token` | public |
| GET | `/api/ycuser/me` | `/api/user/me` | CAMP JWT |
| POST | `/api/ycuser/intention` | `/api/user/intention` | CAMP JWT |
| GET | `/api/ycuser/intention` | `/api/user/intention` | CAMP JWT |
| POST | — | `/api/auth/logout` | public |

### Payments

| Method | CAMP namespace | Alias | Auth |
|--------|----------------|-------|------|
| POST | `/api/ycpayment/initiate` | `/api/payment/initiate` | CAMP JWT |
| POST | `/api/ycpayment/verify` | `/api/payment/verify` | CAMP JWT |
| POST | `/api/ycpayment/recovery` | `/api/payment/recovery` | CAMP JWT |
| POST | `/api/ycpayment/webhook` | `/api/payment/webhook` | `verif-hash` |
| POST | `/api/ycpayment/giveaway/resolve` | `/api/payment/giveaway/resolve` | CAMP JWT |
| POST | `/api/ycpayment/giveaway/transfer` | `/api/payment/giveaway/transfer` | CAMP JWT |

### Admin

| Method | CAMP namespace | Alias | Auth |
|--------|----------------|-------|------|
| GET | `/api/ycadmin/campers` | `/api/admin/campers` | admin |
| GET | `/api/ycadmin/campers/:id` | `/api/admin/campers/:id` | admin |
| GET | `/api/ycadmin/payments` | `/api/admin/payments` | admin |
| GET | `/api/ycadmin/meal-logs?day=` | `/api/admin/meal-logs` | admin |
| POST | `/api/ycadmin/meal-logs` | `/api/admin/meal-logs` | admin |
| GET | `/api/ycadmin/souvenirs` | `/api/admin/souvenirs` | admin |
| GET | `/api/ycadmin/souvenir-count` | `/api/admin/souvenir-count` | admin |
| POST | `/api/ycadmin/meal-scan` | `/api/admin/meal-scan` | admin |
| POST | `/api/ycadmin/souvenir-scan` | `/api/admin/souvenir-scan` | admin |
| PATCH/PUT | `/api/ycadmin/campers/:id/role` | `/api/admin/campers/:id/role` | admin |
| GET | `/api/ycadmin/reports/payment-status` | `/api/admin/reports/payment-status` | admin |
| GET | `/api/ycadmin/reports/financial-summary` | `/api/admin/reports/financial-summary` | admin |
| GET | `/api/ycadmin/expense-reminders` | `/api/admin/expense-reminders` | admin |
| POST | `/api/ycadmin/payment-reminder` | `/api/admin/payment-reminder` | admin |
| POST | `/api/ycadmin/payment-reminders/bulk` | `/api/admin/payment-reminders/bulk` | admin |

### Expenses

| Method | CAMP namespace | Alias | Auth |
|--------|----------------|-------|------|
| GET | `/api/ycadmin/expenses` | `/api/admin/expenses` | admin |
| GET | `/api/ycadmin/expenses/:id` | `/api/admin/expenses/:id` | admin |
| POST | `/api/ycadmin/expenses` | `/api/admin/expenses` | admin |
| PATCH | `/api/ycadmin/expenses/:id/approve` | `/api/admin/expenses/:id/approve` | admin |
| GET | `/api/ycadmin/summary` | `/api/admin/summary` | admin |

### Chat / Handover / FAQ

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/ychat/log` | optional JWT |
| GET | `/api/ychat/context` | optional JWT |
| GET | `/api/ychat/history` | CAMP JWT |
| GET | `/api/ychat/user/:userId` | admin |
| POST | `/api/ychat/handover` | optional JWT |
| GET | `/api/ychat/handovers` | admin |
| POST | `/api/ychat/handovers/:id/resolve` | admin |
| GET | `/api/faq` | public |
| GET | `/api/faq/manage` | admin |
| POST | `/api/faq` | admin |
| PUT | `/api/faq/:id` | admin |
| DELETE | `/api/faq/:id` | admin |

---

## Business rules

- **Target fee:** ₦5,000 (`CAMP_TARGET_FEE`)
- **Teams:** KETER, KAVOD, KISSEH, KLIRONOMOS, ARMON, SHARBIT, MALCHUT, MEMSHALAH
- **Buses:** 1–5
- **Beds:** gender-prefixed `M-001` / `F-001`, collision-protected

Team, bus and bed are assigned **once**, the first time a camper reaches
the target fee — whether by direct payment or by giveaway. Assignment
probes forward to avoid collisions under concurrent payments.

---

## Payment isolation

- Uses only `CAMP_FLW_*` credentials; the GLS backend keeps its own.
- The reference is minted **server-side** (`YC-<camperId>-<timestamp>`),
  so the client cannot forge a transaction.
- Every payment is verified server-to-server with Flutterwave before any
  credit is applied.
- **Idempotency is enforced at the database level** — `reference` and
  `transactionId` are uniquely indexed, so a repeated webhook cannot
  credit a camper twice, even concurrently.
- A `/recovery` endpoint re-runs verification idempotently when the
  primary attempt hits a transient error.

---

## Authentication isolation

CAMP tokens are signed with `CAMP_JWT_SECRET` and carry `app: "CAMP"`.
`YCAuthMiddleware` rejects any token without that claim, so a GLS JWT can
never authenticate against CAMP even though both share one database.

Password reset uses a token-link flow: the raw token is emailed, only its
SHA-256 hash is stored, and it expires in 15 minutes. The endpoint returns
a generic message to prevent user enumeration.

---

## AI agent support

- **Chat persistence + daily quota** — guests 10/day, logged-in campers
  15/day, admins unlimited. Enforced server-side in `YCChatController`.
- **Live FAQ** — the agent fetches `GET /api/faq` on every turn, so admin
  edits apply immediately.
- **Human handover** — the agent (or a camper) files questions it cannot
  answer; admins list, resolve, and optionally promote the resolution
  into the FAQ knowledge base.
- **Admin tools** — the agent can query campers, payments, expenses,
  financial summaries, and send payment reminders (with two-step
  confirmation) using the caller's own JWT.

---

## Migration from Appwrite

```bash
npm run migrate:camp       # legacy Appwrite → CAMP Mongo collections
npm run verify:migration   # reconciliation report
```

The migration is **idempotent** (safe to re-run) and preserves
`legacyAppwriteId` on every record for traceability. Relationships are
remapped from Appwrite string ids onto Mongo ObjectIds.

Appwrite passwords cannot be transferred, so migrated campers have no
password and must use the token-link reset flow. They automatically
receive a branded "we upgraded our platform" email explaining this.

---

## Tests

```bash
npm test
```

Verifies module loading, GLS isolation, JWT scoping, collection
namespacing, idempotency indexes and route registration.
