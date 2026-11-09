import express from 'express';
import mongoose from 'mongoose';
import { connectDb, env, envFloat, envInt, errorHandler, log, notFound, startServer } from '@dtramp/shared';
import { selectCities } from './cities';
import { Ride } from './models';
import { createDriverSource } from './simulation';
import { createRoadRouter } from './router';
import { buildRoutes } from './routes';
import { trafficKind } from './traffic';

// Парк распределён по городам из cities.ts; MAP_CITIES сужает список или задаёт свою
// точку — для демо в регионе, которого в таблице нет (и для которого собран свой граф OSRM).
const config = {
  cities: selectCities({ allow: env('MAP_CITIES', ''), adHocRadiusKm: envFloat('MAP_ADHOC_RADIUS_KM', 8) }),
  count: envInt('MAP_DRIVER_COUNT', 90),
  radiusKm: envFloat('MAP_RADIUS_KM', 3),
  minNear: envInt('MAP_MIN_NEAR', 6),
  tickMs: envInt('SIM_TICK_MS', 500),
  seed: process.env.MAP_SEED ? Number(process.env.MAP_SEED) : undefined,
};

const roads = createRoadRouter();
const source = createDriverSource(config, roads);

const app = express();
app.use(express.json({ limit: '128kb' }));

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'map-service',
    driverSource: source.kind,
    router: roads.kind,
    traffic: trafficKind(),
    drivers: config.count,
    cities: config.cities.length,
    mongo: mongoose.connection.readyState === 1 ? 'up' : 'down',
  });
});

app.use(buildRoutes(source, { radiusKm: config.radiusKm, roads }));
app.use(notFound);
app.use(errorHandler);

await connectDb('map-service');
await source.start();
// Парк симуляции живёт в памяти: после рестарта водителей прошлого запуска нет,
// и продолжать их заказы некому. Закрываем их, иначе они навсегда остаются активными
// и блокируют новые вызовы. «arrived» не трогаем — там пассажир ещё может нажать «Я вышел».
const stale = await Ride.updateMany(
  { status: { $in: ['accepted', 'driver_arrived', 'boarded'] } },
  [{ $set: { status: 'cancelled', refundPending: { $gt: ['$price', 0] } } }],
);
if (stale.modifiedCount) log.warn('Закрыты заказы прошлого запуска симуляции', { rides: stale.modifiedCount });
process.on('SIGTERM', () => void source.stop());
process.on('SIGINT', () => void source.stop());

startServer(app, 'map-service');
log.info('map-service готов', {
  cities: config.cities.map((city) => city.name).join(', '),
  radiusKm: config.radiusKm,
  count: config.count,
});

