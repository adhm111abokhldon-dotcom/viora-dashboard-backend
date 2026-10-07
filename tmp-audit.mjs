import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
await mongoose.connect(process.env.MONGODB_URI);
const rows = await mongoose.connection.collection('advertisingexpenses').aggregate([
  { $match: { source: 'windsor' } },
  { $group: { _id: { store: '$store', accountId: '$accountId', accountName: '$accountName', status: '$accountStatus' }, spend: { $sum: '$amount' }, rows: { $sum: 1 } } },
  { $sort: { spend: -1 } },
]).toArray();
console.log('WINDSOR ACCOUNTS:');
console.log(JSON.stringify(rows, null, 1));
const orders = await mongoose.connection.collection('orders').countDocuments();
const withNum = await mongoose.connection.collection('orders').countDocuments({ orderNumber: { $exists: true } });
console.log('orders:', orders, 'withOrderNumber:', withNum);
console.log('products:', await mongoose.connection.collection('products').countDocuments());
const campaigns = await mongoose.connection.collection('advertisingexpenses').aggregate([
  { $match: { source: 'windsor' } },
  { $group: { _id: { store: '$store', accountId: '$accountId', campaign: '$campaign' }, spend: { $sum: '$amount' } } },
  { $sort: { '_id.accountId': 1, spend: -1 } },
]).toArray();
console.log('CAMPAIGNS (' + campaigns.length + '):');
console.log(JSON.stringify(campaigns, null, 1));
await mongoose.disconnect();
