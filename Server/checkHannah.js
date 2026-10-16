// Check Hannah's payment records
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

(async () => {
  try {
    await mongoose.connect(process.env.CAMP_MONGO_URL, {
      dbName: process.env.CAMP_MONGO_DB || 'camp',
    });
    console.log('Connected to camp');

    const YCUser = require('../Model/YCUser');
    const YCPayment = require('../Model/YCPayment');

    // Find Hannah
    const hannah = await YCUser.findOne({ _id: '6ac4e78a4ebb36863a50c2ed' }).lean();
    console.log('\nHannah user record:');
    console.log('  _id:', hannah._id);
    console.log('  name:', hannah.name);
    console.log('  amount_paid:', hannah.amount_paid);
    console.log('  updatedAt:', hannah.updatedAt);
    console.log('  createdAt:', hannah.createdAt);

    // Find Hannah's payment records
    const payments = await YCPayment.find({ camperId: '6ac4e78a4ebb36863a50c2ed' }).lean();
    console.log('\nHannah payment records (' + payments.length + '):');
    let total = 0;
    for (const p of payments) {
      const amt = Number(p.amount) || 0;
      total += amt;
      console.log('  _id:', p._id, '| amount:', amt, '| status:', p.status, '| ref:', p.reference || p.tx_ref || 'N/A', '| date:', p.createdAt || p.date);
    }
    console.log('\n  Total payments:', total);
    console.log('  amount_paid:', hannah.amount_paid);
    console.log('  Excess:', total - hannah.amount_paid);

    await mongoose.connection.close();
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
