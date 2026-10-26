#!/usr/bin/env node
// Remove only the known smoke-test driver accounts and their trips/bookings.
import mongoose from 'mongoose';

try {
  await mongoose.connect(process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/dtramp', { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;
  const users = await db.collection('users').find({
    email: /^driver[0-9]+@dtramp\.test$/,
    name: { $in: ['Иван Водителев', 'Тестовый водитель'] },
  }, { projection: { _id: 1 } }).toArray();
  const userIds = users.map(user => user._id.toString());
  const trips = await db.collection('trips').find({ driverId: { $in: userIds } }, { projection: { _id: 1 } }).toArray();
  const tripIds = trips.map(trip => trip._id);
  // Refuse to orphan unrelated data if somebody has started using a test account manually.
  const unrelatedBookings = await db.collection('bookings').countDocuments({ userId: { $in: userIds }, tripId: { $nin: tripIds } });
  const rides = await db.collection('rides').countDocuments({ userId: { $in: userIds } });
  if (unrelatedBookings || rides) throw Error('У тестового водителя есть сторонние брони или заказы. Автоматическая очистка остановлена до удаления данных.');
  if (process.argv.includes('--dry-run')) {
    console.log(`Будет удалено: ${users.length} тестовых водителей, ${trips.length} поездок и связанные с ними брони.`);
  } else {
    const bookingsDeleted = await db.collection('bookings').deleteMany({ tripId: { $in: tripIds } });
    const tripsDeleted = await db.collection('trips').deleteMany({ _id: { $in: tripIds } });
    const usersDeleted = await db.collection('users').deleteMany({ _id: { $in: users.map(user => user._id) } });
    console.log(`Удалено: ${usersDeleted.deletedCount} тестовых водителей, ${tripsDeleted.deletedCount} поездок, ${bookingsDeleted.deletedCount} броней.`);
  }
} catch (error) {
  console.error(`Очистка не выполнена: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
