// Remove Hannah's duplicate payments with quarantine
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const BACKUP_DIR = path.join(__dirname, '../backups');
const QUARANTINE_COL = 'ycpayments_quarantine';

// Hannah's duplicate payment IDs to remove
const DUPLICATE_IDS = [
  '6ac4fb91e0f4b8dd4bc94f98', // ₦1,003 - duplicate of ...1780531358138
  '6ac4fb93e0f4b8dd4bc94f99', // ₦1,003 - duplicate of ...1784099022750
  '6ac4fb97e0f4b8dd4bc94f9a', // ₦2,005 - duplicate of ...1786910316780
];

(async () => {
  try {
    await mongoose.connect(process.env.CAMP_MONGO_URL, {
      dbName: process.env.CAMP_MONGO_DB || 'camp',
    });
    console.log('Connected to camp');

    const YCUser = require('../Model/YCUser');
    const YCPayment = require('../Model/YCPayment');

    // Ensure quarantine collection exists
    await mongoose.connection.db.createCollection(QUARANTINE_COL).catch(() => {});

    // Verify Hannah's current state
    const hannah = await YCUser.findOne({ _id: '6ac4e78a4ebb36863a50c2ed' }).lean();
    console.log('\nHannah amount_paid:', hannah.amount_paid);

    const before = await YCPayment.find({ camperId: '6ac4e78a4ebb36863a50c2ed' }).lean();
    const beforeSum = before.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    console.log('Before: ' + before.length + ' records, sum = ' + beforeSum);

    // Remove duplicates with quarantine
    const log = { removed: [], timestamp: new Date().toISOString() };

    for (const id of DUPLICATE_IDS) {
      const doc = await YCPayment.findOne({ _id: id }).lean();
      if (!doc) {
        console.log('  Skip ' + id + ': not found');
        continue;
      }

      // Quarantine first
      await mongoose.connection.db.collection(QUARANTINE_COL).insertOne({
        ...doc,
        _id: new mongoose.Types.ObjectId(),
        removedAt: new Date(),
        removedReason: 'Duplicate payment - same Flutterwave reference as earlier record',
        originalId: doc._id,
      });

      // Then delete
      await YCPayment.deleteOne({ _id: id });
      log.removed.push({ originalId: id, amount: doc.amount, reference: doc.reference });
      console.log('  Removed: ' + id + ' (₦' + doc.amount + ')');
    }

    // Verify after
    const after = await YCPayment.find({ camperId: '6ac4e78a4ebb36863a50c2ed' }).lean();
    const afterSum = after.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    console.log('\nAfter: ' + after.length + ' records, sum = ' + afterSum);
    console.log('amount_paid:', hannah.amount_paid);
    console.log('Match:', afterSum === hannah.amount_paid ? '✅ YES' : '❌ NO');

    // Save log
    const logPath = path.join(BACKUP_DIR, 'hannah-removal-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    console.log('\nLog saved:', logPath);

    await mongoose.connection.close();
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
