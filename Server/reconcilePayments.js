// CAMP-Backend/Server/reconcilePayments.js
// Reconcile ycusers.amount_paid against ycpayments collections
// DRY-RUN by default; run with --apply to execute changes

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = path.join(__dirname, '../backups');
const QUARANTINE_COL = 'ycpayments_quarantine';

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

// ── Models (use real field names from the actual schemas) ──
const YCUser = require('../Model/YCUser');
const YCPayment = require('../Model/YCPayment');

const SUCCESS_STATUSES = ['success', 'transfer_in'];

const isSuccessful = (doc) => SUCCESS_STATUSES.includes(doc.status);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── PHASE 0: BACKUP ──
async function backup() {
  console.log('=== PHASE 0: BACKUP ===');
  const users = await YCUser.find({}).lean();
  const payments = await YCPayment.find({}).lean();
  const uPath = path.join(BACKUP_DIR, `ycusers-${ts()}.json`);
  const pPath = path.join(BACKUP_DIR, `ycpayments-${ts()}.json`);
  fs.writeFileSync(uPath, JSON.stringify(users, null, 2));
  fs.writeFileSync(pPath, JSON.stringify(payments, null, 2));
  console.log(`  YCUser: ${users.length} → ${uPath}`);
  console.log(`  YCPayment: ${payments.length} → ${pPath}`);
  return { users, payments };
}

// ── PHASE 1: AUDIT ──
async function audit(users, payments) {
  console.log('\n=== PHASE 1: AUDIT ===');
  const payByUser = {};
  for (const p of payments) {
    const uid = String(p.camperId);
    if (!payByUser[uid]) payByUser[uid] = [];
    payByUser[uid].push(p);
  }

  const flagged = [];
  let totalAmountPaid = 0;
  let totalPayments = 0;

  for (const u of users) {
    const uid = String(u._id);
    const ap = num(u.amount_paid);
    totalAmountPaid += ap;
    const recs = (payByUser[uid] || []).filter(isSuccessful);
    const sum = recs.reduce((s, r) => s + num(r.amount), 0);
    totalPayments += sum;

    const issues = [];
    if (ap > 0 && recs.length === 0) issues.push('A');
    if (recs.length > 0 && sum > ap) issues.push('B');
    if (recs.length > 0 && sum < ap) issues.push('C');

    // D: duplicates by reference
    const refSeen = {};
    for (const r of recs) {
      const ref = r.reference || r.tx_ref || r.flw_ref || '';
      if (ref && refSeen[ref]) issues.push('D');
      if (ref) refSeen[ref] = true;
    }

    if (issues.length > 0) {
      flagged.push({ _id: uid, name: u.name, amount_paid: ap, count: recs.length, sum, issues, records: recs });
    }
  }

  // E: orphan payments
  const userIds = new Set(users.map(u => String(u._id)));
  const orphans = payments.filter(p => !userIds.has(String(p.camperId)));

  console.log(`  Total ycusers.amount_paid: ${totalAmountPaid}`);
  console.log(`  Total ycpayments (successful): ${totalPayments}`);
  console.log(`  Flagged users: ${flagged.length}`);
  console.log(`  Orphan payments: ${orphans.length}`);

  for (const f of flagged) {
    console.log(`  ${f.issues.join(',')} | ${f.name} (${f._id}) | amount_paid=${f.amount_paid} | records=${f.count} | sum=${f.sum}`);
  }

  const report = { totalAmountPaid, totalPayments, flagged, orphans, timestamp: new Date().toISOString() };
  const rPath = path.join(BACKUP_DIR, `audit-${ts()}.json`);
  fs.writeFileSync(rPath, JSON.stringify(report, null, 2));
  console.log(`  Report saved: ${rPath}`);

  return { flagged, orphans, totalAmountPaid, totalPayments };
}

// ── PHASE 2: FIX PLAN ──
function buildPlan(flagged) {
  console.log('\n=== PHASE 2: FIX PLAN ===');
  const toCreate = [];
  const toRemove = [];
  const needsReview = [];

  for (const f of flagged) {
    const ap = f.amount_paid;
    const sum = f.sum;

    if (f.issues.includes('A') || f.issues.includes('C')) {
      const missing = ap - sum;
      if (missing > 0) {
        toCreate.push({ userId: f._id, name: f.name, amount: missing, reason: f.issues.includes('A') ? 'A' : 'C' });
      }
    }

    if (f.issues.includes('B') || f.issues.includes('D')) {
      const excess = sum - ap;
      if (excess > 0) {
        // Try to find records to remove
        const sorted = [...f.records].sort((a, b) => new Date(a.createdAt || a.date || 0) - new Date(b.createdAt || b.date || 0));
        let remaining = excess;
        const removeIds = [];
        for (const r of sorted) {
          if (remaining <= 0) break;
          const amt = num(r.amount);
          if (amt <= remaining) {
            removeIds.push(r._id);
            remaining -= amt;
          }
        }
        if (remaining === 0) {
          toRemove.push({ userId: f._id, name: f.name, removeIds, excess });
        } else {
          needsReview.push({ userId: f._id, name: f.name, records: f.records, excess, reason: 'Cannot unambiguously remove' });
        }
      }
    }
  }

  console.log(`  To create: ${toCreate.length}`);
  for (const c of toCreate) console.log(`    ${c.reason} | ${c.name} (${c.userId}) | amount=${c.amount}`);
  console.log(`  To remove: ${toRemove.length}`);
  for (const r of toRemove) console.log(`    ${r.name} (${r.userId}) | remove ${r.removeIds.length} records | excess=${r.excess}`);
  console.log(`  Needs manual review: ${needsReview.length}`);
  for (const n of needsReview) console.log(`    ${n.name} (${n.userId}) | excess=${n.excess} | ${n.reason}`);

  return { toCreate, toRemove, needsReview };
}

// ── PHASE 3: APPLY ──
async function apply(plan, payments) {
  console.log('\n=== PHASE 3: APPLY ===');
  const log = { created: [], removed: [], timestamp: new Date().toISOString() };

  // Ensure quarantine collection exists
  await mongoose.connection.db.createCollection(QUARANTINE_COL).catch(() => {});

  for (const r of plan.toRemove) {
    for (const id of r.removeIds) {
      const doc = payments.find(p => String(p._id) === String(id));
      if (!doc) continue;
      // Quarantine first
      await mongoose.connection.db.collection(QUARANTINE_COL).insertOne({
        ...doc,
        _id: new mongoose.Types.ObjectId(),
        removedAt: new Date(),
        removedReason: `Reconciliation: over-recorded for user ${r.userId}`,
        originalId: doc._id,
      });
      // Then delete
      await YCPayment.deleteOne({ _id: id });
      log.removed.push({ originalId: id, userId: r.userId, amount: doc.amount });
      console.log(`  Removed payment ${id} (${doc.amount}) from ${r.name}`);
    }
  }

  for (const c of plan.toCreate) {
    // Idempotent: skip if RECON record exists
    const existing = await YCPayment.findOne({ reference: `RECON-${c.userId}` });
    if (existing) {
      console.log(`  Skip ${c.name}: RECON record already exists`);
      continue;
    }
    const user = await YCUser.findById(c.userId).lean();
    const date = user?.updatedAt || user?.createdAt || new Date();
    const doc = {
      camperId: c.userId,
      type: 'ubcyc',
      reference: `RECON-${c.userId}`,
      amount: c.amount,
      date: date,
      year: new Date(date).getFullYear(),
      status: 'success',
      source: 'manual_reconciliation',
      note: 'Backfilled from amount_paid',
    };
    await YCPayment.create(doc);
    log.created.push({ userId: c.userId, name: c.name, amount: c.amount });
    console.log(`  Created payment for ${c.name}: ${c.amount}`);
  }

  const lPath = path.join(BACKUP_DIR, `applied-${ts()}.json`);
  fs.writeFileSync(lPath, JSON.stringify(log, null, 2));
  console.log(`  Log saved: ${lPath}`);
  return log;
}

// ── PHASE 4: VERIFY ──
async function verify() {
  console.log('\n=== PHASE 4: VERIFY ===');
  const users = await YCUser.find({}).lean();
  const payments = await YCPayment.find({}).lean();
  const payByUser = {};
  for (const p of payments) {
    const uid = String(p.camperId);
    if (!payByUser[uid]) payByUser[uid] = [];
    payByUser[uid].push(p);
  }
  let mismatched = 0;
  let totalAP = 0;
  let totalPay = 0;
  for (const u of users) {
    const uid = String(u._id);
    const ap = num(u.amount_paid);
    totalAP += ap;
    const recs = (payByUser[uid] || []).filter(isSuccessful);
    const sum = recs.reduce((s, r) => s + num(r.amount), 0);
    totalPay += sum;
    if (ap !== sum) mismatched++;
  }
  console.log(`  Mismatched users: ${mismatched}`);
  console.log(`  Total ycusers.amount_paid: ${totalAP}`);
  console.log(`  Total ycpayments: ${totalPay}`);
  console.log(`  Difference: ${totalAP - totalPay}`);
  return { mismatched, totalAP, totalPay };
}

// ── MAIN ──
(async () => {
  try {
    await mongoose.connect(process.env.CAMP_MONGO_URL, {
      dbName: process.env.CAMP_MONGO_DB || 'camp',
    });
    console.log(`Connected to ${process.env.CAMP_MONGO_DB || 'camp'}`);

    const { users, payments } = await backup();
    const { flagged, orphans } = await audit(users, payments);
    const plan = buildPlan(flagged);

    if (APPLY) {
      await apply(plan, payments);
      await verify();
    } else {
      console.log('\n*** DRY-RUN MODE — no changes written ***');
      console.log('Run with --apply to execute.');
    }

    await mongoose.connection.close();
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
