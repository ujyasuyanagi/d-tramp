/** Реальные HTTP/GraphQL-маршруты и отдельная временная БД MongoDB; парк детерминированный. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { errorHandler, tokenFromHeader, verifyToken } from '@dtramp/shared';
import userRoutes from '../../user-service/src/routes';
import tripRoutes from '../../trip-service/src/routes';
import { buildRoutes } from '../../map-service/src/routes';
import { User } from '../../user-service/src/models';
import { Trip, Booking } from '../../trip-service/src/models';
import { Ride } from '../../map-service/src/models';
import type { DriverSource } from '../../map-service/src/driver-source';
import type { RoadRouter } from '../../map-service/src/router';

const dbName = `dtramp_regression_${Date.now()}_${process.pid}`;
const servers: Server[] = [];
let apollo: ApolloServer<any> | undefined;
let passed = 0;
let refundUnavailable = false;
let confirmationUnavailable = false;
let loseDebitResponse = false;
let atPickup = false;
let atDestination = false;
let pickupBarrier: (() => Promise<boolean>) | undefined;
let releaseCount = 0;
const driverId = new mongoose.Types.ObjectId().toString();
const car = { model: 'Toyota Camry', plate: 'А123АА777' };
const driver = { id: driverId, name: 'Водитель проверки', car, rating: 5, lat: 55.76, lon: 37.61, status: 'free' as const, pricePerKm: 20, freeRide: false, speedKmh: 40, heading: 0, regionLabel: 'Москва' };
let busy = false;
const source: DriverSource = {
  kind: 'regression',
  async start() {}, async stop() {},
  async listNear() { return [{ ...driver, status: busy ? 'busy' : 'free', distanceKm: 0.2 }]; },
  async nearestFree() { return busy ? null : { driver, distanceKm: 0.2 }; },
  async acquire() { if (busy) return null; busy = true; return { driver, route: null }; },
  async release() { busy = false; releaseCount += 1; },
  async board() {},
  async arrivedAtPickup() { return pickupBarrier ? pickupBarrier() : atPickup; },
  async arrivedAtDestination() { return atDestination; },
  async stats() { return { kind: 'regression', router: 'off', total: 1, free: busy ? 0 : 1, busy: busy ? 1 : 0, cities: [], byRegion: [] }; },
};
const roads: RoadRouter = { kind: 'off', async route() { return null; }, async snap() { return null; } };
process.env.MAP_TRAFFIC = 'off';

function check(name: string) { passed += 1; console.log(`✓ ${name}`); }
async function listen(app: express.Express) {
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function http(base: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as any };
}

try {
  // dbName принудительно заменяет БД даже в пользовательском MONGO_URL.
  await mongoose.connect(process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017', { dbName, serverSelectionTimeoutMS: 5_000 });
  await Promise.all([User.init(), Trip.init(), Booking.init(), Ride.init()]);
  const userApp = express();
  userApp.use(express.json());
  userApp.use((req, res, next) => {
    if (req.path === '/me/balance/refund' && refundUnavailable) {
      res.status(503).json({ error: 'Проверка недоступности кошелька' }); return;
    }
    if (req.path === '/me/balance/debit' && loseDebitResponse) {
      loseDebitResponse = false;
      const json = res.json.bind(res);
      res.json = (() => { res.status(502); return json({ error: 'Списание сохранено, ответ потерян' }); }) as typeof res.json;
    }
    next();
  });
  userApp.use(userRoutes);
  const userUrl = await listen(userApp);
  const tripApp = express(); tripApp.use(express.json(), tripRoutes);
  const tripUrl = await listen(tripApp);
  const mapApp = express(); mapApp.use(express.json());
  mapApp.use((req, res, next) => {
    if (req.path.endsWith('/refund-complete') && confirmationUnavailable) {
      res.status(503).json({ error: 'Подтверждение возврата недоступно' }); return;
    }
    next();
  });
  mapApp.use(buildRoutes(source, { radiusKm: 3, roads }));
  const mapUrl = await listen(mapApp);
  process.env.USER_SERVICE_URL = userUrl;
  process.env.TRIP_SERVICE_URL = tripUrl;
  process.env.MAP_SERVICE_URL = mapUrl;
  const { resolvers, createContext } = await import('../src/resolvers');
  const { typeDefs } = await import('../src/schema');
  apollo = new ApolloServer({ typeDefs, resolvers }); await apollo.start();
  const gateway = express();
  gateway.use('/graphql', express.json(), expressMiddleware(apollo, { context: async ({ req }) => {
    const token = tokenFromHeader(req.headers.authorization);
    return createContext(token, token ? verifyToken(token) : undefined);
  } }));
  const gatewayUrl = await listen(gateway);
  const gql = async (query: string, variables: Record<string, unknown>, token: string) => (await http(gatewayUrl, '/graphql', token, { query, variables })).body;
  const registered = await http(userUrl, '/register', '', { email: 'driver@regression.test', name: 'Водитель', password: 'regression123', role: 'driver' });
  assert.equal(registered.status, 201);
  const ownerToken = registered.body.token;
  const rider = await http(userUrl, '/register', '', { email: 'rider@regression.test', name: 'Пассажир', password: 'regression123', role: 'passenger' });
  const token = rider.body.token;
  const riderId = rider.body.user.id;
  const outsider = await http(userUrl, '/register', '', { email: 'other@regression.test', name: 'Другой пассажир', password: 'regression123' });
  const otherToken = outsider.body.token;
  const point = { lat: 55.76, lon: 37.61 };
  const destination = { lat: 55.77, lon: 37.65 };
  const trip = await http(tripUrl, '/trips', ownerToken, { from: point, to: destination, dateTime: new Date(Date.now() + 86_400_000).toISOString(), seats: 3, price: 100 });
  assert.equal(trip.status, 201);
  const tripId = trip.body._id;
  assert.equal((await http(tripUrl, `/trips/${tripId}/book`, ownerToken, { seats: 1 })).status, 403);
  assert.equal((await Trip.findById(tripId))!.seatsAvailable, 3);
  check('Самобронь запрещена и не списывает места');
  const booked = await http(tripUrl, `/trips/${tripId}/book`, token, { seats: 2 });
  assert.equal(booked.status, 201);
  const bookingId = booked.body._id;
  assert.equal((await http(tripUrl, `/bookings/${bookingId}/cancel`, otherToken, {})).status, 403);
  const cancellations = await Promise.all(Array.from({ length: 12 }, () => http(tripUrl, `/bookings/${bookingId}/cancel`, token, {})));
  assert.equal(cancellations.filter(x => x.status === 200).length, 1);
  assert.equal(cancellations.filter(x => x.status === 409).length, 11);
  assert.equal((await Trip.findById(tripId))!.seatsAvailable, 3);
  check('12 параллельных отмен возвращают места ровно один раз; чужая отмена запрещена');

  const paymentId = new mongoose.Types.ObjectId().toString();
  const debits = await Promise.all(Array.from({ length: 8 }, () => http(userUrl, '/me/balance/debit', token, { rideId: paymentId, amount: 80 })));
  assert.ok(debits.every(x => x.status === 200));
  assert.equal((await User.findById(riderId))!.balance, 420);
  assert.ok(!('ridePayments' in debits[0]!.body));
  check('Повторное списание по id заказа безопасно; журнал платежей не раскрывается');
  const refunds = await Promise.all(Array.from({ length: 8 }, () => http(userUrl, '/me/balance/refund', token, { rideId: paymentId })));
  assert.ok(refunds.every(x => x.status === 200));
  assert.equal((await User.findById(riderId))!.balance, 500);
  assert.equal((await http(userUrl, '/me/balance/debit', token, { rideId: paymentId, amount: 80 })).status, 409);
  check('Параллельные возвраты не создают деньги и запрещают повторное списание');
  const racingPayments = await Promise.all(Array.from({ length: 8 }, () => http(userUrl, '/me/balance/debit', token, { rideId: new mongoose.Types.ObjectId().toString(), amount: 400 })));
  assert.equal(racingPayments.filter(x => x.status === 200).length, 1);
  assert.equal(await User.findById(riderId).then(user => user!.balance), 100);
  await User.updateOne({ _id: riderId }, { $set: { balance: 500 } });
  check('Разные заказы не могут одновременно потратить один баланс');
  const unpaidId = new mongoose.Types.ObjectId().toString();
  await http(userUrl, '/me/balance/refund', token, { rideId: unpaidId });
  assert.equal((await http(userUrl, '/me/balance/debit', token, { rideId: unpaidId, amount: 80 })).status, 409);
  assert.equal((await User.findById(riderId))!.balance, 500);
  check('Отмена неоплаченного заказа не пополняет баланс и блокирует запоздалое списание');

  const requestRide = async () => {
    const result = await gql('mutation($input: RequestRideInput!) { requestRide(input: $input) { ride { id status price refundPending } } }', { input: { pickup: point, dest: destination, radiusKm: 3 } }, token);
    assert.ok(!result.errors, JSON.stringify(result.errors)); return result.data.requestRide.ride;
  };
  const cancel = (id: string, who = token) => gql('mutation($id: ID!) { cancelRide(id: $id) { id status refundPending } }', { id }, who);
  const balance = async () => (await User.findById(riderId))!.balance;
  const paidRide = await requestRide();
  assert.ok(paidRide.price > 0); assert.equal(await balance(), 500 - paidRide.price);
  assert.equal((await cancel(paidRide.id, otherToken)).errors[0].extensions.code, 'FORBIDDEN');
  const releasesBefore = releaseCount;
  const cancelledRides = await Promise.all(Array.from({ length: 8 }, () => cancel(paidRide.id)));
  assert.ok(cancelledRides.every(x => x.data?.cancelRide?.status === 'CANCELLED' && !x.data.cancelRide.refundPending));
  assert.equal(await balance(), 500); assert.equal(releaseCount, releasesBefore + 1);
  check('GraphQL: списание и параллельные отмены дают один возврат и одно освобождение машины');

  const pendingRide = await requestRide();
  refundUnavailable = true;
  const failedRefund = await cancel(pendingRide.id);
  assert.equal(failedRefund.errors[0].extensions.status, 502);
  assert.equal((await Ride.findById(pendingRide.id))!.status, 'cancelled');
  assert.equal((await Ride.findById(pendingRide.id))!.refundPending, true);
  assert.equal(await balance(), 500 - pendingRide.price);
  refundUnavailable = false;
  assert.equal((await cancel(pendingRide.id)).data.cancelRide.refundPending, false);
  assert.equal(await balance(), 500);
  check('Сбой возврата виден клиенту; повтор отмены завершает возврат');

  const unconfirmedRide = await requestRide();
  confirmationUnavailable = true;
  assert.ok((await cancel(unconfirmedRide.id)).errors);
  assert.equal(await balance(), 500);
  assert.equal((await Ride.findById(unconfirmedRide.id))!.refundPending, true);
  confirmationUnavailable = false;
  assert.equal((await cancel(unconfirmedRide.id)).data.cancelRide.refundPending, false);
  assert.equal(await balance(), 500);
  check('Сбой подтверждения после возврата не приводит к повторному зачислению');

  loseDebitResponse = true;
  const lost = await gql('mutation($input: RequestRideInput!) { requestRide(input: $input) { ride { id } } }', { input: { pickup: point, dest: destination } }, token);
  assert.ok(lost.errors); assert.equal(await balance(), 500); assert.equal(busy, false);
  check('Потерянный ответ после списания компенсируется отменой и возвратом');

  await User.updateOne({ _id: riderId }, { $set: { balance: 1 } });
  const poor = await gql('mutation($input: RequestRideInput!) { requestRide(input: $input) { ride { id } } }', { input: { pickup: point, dest: destination } }, token);
  assert.equal(poor.errors[0].extensions.status, 402); assert.equal(await balance(), 1); assert.equal(busy, false);
  check('Недостаточный баланс не уходит в минус; неоплаченный заказ освобождает машину');
  await User.updateOne({ _id: riderId }, { $set: { balance: 500 } });

  const fullRide = await requestRide(); const afterPayment = await balance();
  const board = () => gql('mutation($id: ID!) { boardRide(id: $id) { status } }', { id: fullRide.id }, token);
  const exit = () => gql('mutation($id: ID!) { exitRide(id: $id) { status } }', { id: fullRide.id }, token);
  assert.ok((await board()).errors);
  atPickup = true; assert.equal((await board()).data.boardRide.status, 'BOARDED');
  assert.ok((await cancel(fullRide.id)).errors); assert.ok((await exit()).errors);
  atDestination = true; assert.equal((await exit()).data.exitRide.status, 'COMPLETED');
  assert.ok((await cancel(fullRide.id)).errors); assert.equal(await balance(), afterPayment);
  check('Полный цикл посадки и выхода; отмена после посадки запрещена, повторного списания нет');
  atPickup = false; atDestination = false;

  const raceRide = await requestRide();
  let entered!: () => void; let resume!: (value: boolean) => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  pickupBarrier = () => { entered(); return new Promise<boolean>(resolve => { resume = resolve; }); };
  const polling = http(mapUrl, `/rides/${raceRide.id}`, token);
  await enteredPromise;
  assert.equal((await cancel(raceRide.id)).data.cancelRide.status, 'CANCELLED');
  resume(true); const polled = await polling; pickupBarrier = undefined;
  assert.equal(polled.body.status, 'cancelled');
  assert.equal((await Ride.findById(raceRide.id))!.status, 'cancelled');
  assert.equal(await balance(), afterPayment);
  check('Опрос, начатый до отмены, не восстанавливает отменённый заказ');
  const legacy = (await Ride.findById(raceRide.id))!.toObject();
  const legacyId = new mongoose.Types.ObjectId();
  await Ride.collection.insertOne({ ...legacy, _id: legacyId, status: 'accepted', paymentVersion: undefined });
  const legacyCancel = await cancel(legacyId.toString());
  assert.equal(legacyCancel.errors[0].extensions.status, 409);
  assert.ok(legacyCancel.errors[0].message.includes('ручной проверки'));
  assert.equal(await balance(), afterPayment);
  check('Старые заказы без истории платежей требуют сверки и не создают произвольный возврат');
  console.log(`\nИтог: ${passed} проверок пройдено`);
} finally {
  await apollo?.stop();
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
  if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
