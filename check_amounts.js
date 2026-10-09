// Check MongoDB amounts after migration
require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.CAMP_MONGO_URL, { dbName: process.env.CAMP_MONGO_DB })
  .then(async () => {
    const YCUser = mongoose.model('YCUser', new mongoose.Schema({ amount_paid: Number }));
    const YCPayment = mongoose.model('YCPayment', new mongoose.Schema({ amount: Number }));
    
    const userCount = await YCUser.countDocuments();
    const paymentCount = await YCPayment.countDocuments();
    
    const totalAmountPaid = await YCUser.aggregate([
      { $group: { _id: null, total: { $sum: '$amount_paid' } } }
    ]);
    
    const paymentTotalAmount = await YCPayment.aggregate([
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    console.log('=== MIGRATION AMOUNT CHECK ===');
    console.log('YCUser count:', userCount);
    console.log('YCPayment count:', paymentCount);
    console.log('Total amount_paid from users:', totalAmountPaid[0]?.total || 0);
    console.log('Total amount from payments:', paymentTotal[0]?.total || 0);
    
    // Also get a sample user to see amount_paid
    const sampleUser = await YCUser.findOne().select('amount_paid name email');
    console.log('Sample user:', sampleUser ? `${sampleUser.name || 'Unknown'} - amount_paid: ${sampleUser.amount_paid}` : 'No users found');
    
    // Get a sample payment
    const samplePayment = await YCPayment.findOne().select('amount camperId status');
    console.log('Sample payment:', samplePayment ? `amount: ${samplePayment.amount}, camper: ${samplePayment.camperId}, status: ${samplePayment.status}` : 'No payments found');
    
    console.log('==============================');
    
    // Check if there's a discrepancy
    const userTotal = totalAmountPaid[0]?.total || 0;
    const paymentTotal = paymentTotal[0]?.total || 0;
    const diff = userTotal - paymentTotal;
    
    if (Math.abs(diff) > 1) {
      console.log(`\n⚠️  DISCREPANCY: user total(${userTotal}) vs payment total(${paymentTotal}) = diff ${diff}`);
    } else {
      console.log(`\n✅  Amounts are consistent (diff: ${diff})`);
    }
    
    mongoose.connection.close();
    process.exit(0);
  })
  .catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });