import { Router } from 'express';
import mongoose from 'mongoose';
import { HttpError, asyncHandler, haversineKm, log, num, point, requireAuth } from '@dtramp/shared';
import type { Acquisition, DriverSource } from './driver-source';
import type { DriverView } from './models';
import { Ride } from './models';
import { decimate, roadBetween, splitRouteAt, type LatLng, type RoadRoute, type RoadRouter } from './router';
import { getTrafficSnapshot, scoreTraffic, type TrafficSnapshot, type TrafficScore } from './traffic';

type RideDoc = mongoose.Document & Record<string, any>;

/** Сколько ближайших машин просматриваем: дальше выигрыш по времени уже съедается дорогой. */
const MAX_TRAFFIC_CANDIDATES = 6;
/** Пересаживаемся только если альтернатива быстрее хотя бы на минуту, а не на секунды. */
const MIN_TRAFFIC_ETA_GAIN = 1;

interface RankedDriver {
  driver: DriverView;
  distanceKm: number;
  traffic: TrafficScore;
  baseMin: number;
  adjustedMin: number;
}

interface DriverChoice {
  snapshot: TrafficSnapshot | null;
  ranked: RankedDriver[];
  nearest?: RankedDriver;
  best?: RankedDriver;
}

/**
 * Ранжируем свободных водителей по времени подачи с учётом пробок. Ближайшая машина
 * остаётся выбором по умолчанию: переключаемся на другую, только если она заметно
 * быстрее и разница объясняется дорожной обстановкой, а не случайным шумом OSRM.
 */
async function rankDrivers(
  source: DriverSource,
  roads: RoadRouter,
  pickup: LatLng,
  radiusKm: number,
): Promise<DriverChoice> {
  const free = (await source.listNear(pickup, radiusKm)).filter((driver) => driver.status === 'free');
  if (!free.length) return { snapshot: null, ranked: [] };

  const snapshot = await getTrafficSnapshot(pickup, radiusKm);
  const ranked = await Promise.all(
    free.slice(0, MAX_TRAFFIC_CANDIDATES).map(async (driver): Promise<RankedDriver> => {
      const here = { lat: driver.lat, lon: driver.lon };
      const distanceKm = driver.distanceKm ?? haversineKm(here.lat, here.lon, pickup.lat, pickup.lon);
      const route = await roads.route(here, [pickup]);
      const baseMin = route?.legs[0]?.durationMin ?? (distanceKm / Math.max(1, driver.speedKmh || 45)) * 60;
      const traffic = scoreTraffic(route?.points ?? [here, pickup], baseMin, snapshot);
      return { driver, distanceKm, traffic, baseMin, adjustedMin: baseMin * traffic.factor };
    }),
  );

  const nearest = ranked[0];
  if (!nearest) return { snapshot, ranked };

  const challenger = ranked
    .filter((entry) => entry.driver.id !== nearest.driver.id)
    .sort((a, b) => a.adjustedMin - b.adjustedMin || a.distanceKm - b.distanceKm)[0];

  const nearestCongested = nearest.traffic.level !== 'unknown' && nearest.traffic.factor > 1.02;
  const challengerClearer =
    challenger !== undefined && challenger.traffic.level !== 'unknown' && challenger.traffic.factor + 0.05 < nearest.traffic.factor;
  const gainMin = challenger ? nearest.adjustedMin - challenger.adjustedMin : 0;
  const best =
    challenger && challenger.traffic.level !== 'unknown' && (nearestCongested || challengerClearer) && gainMin >= MIN_TRAFFIC_ETA_GAIN
      ? challenger
      : nearest;

  return { snapshot, ranked, nearest, best };
}

function toRide(ride: RideDoc) {
  return {
    id: ride.id,
    userId: ride.userId,
    driverId: String(ride.driverId),
    driverName: ride.driverName,
    plate: ride.plate,
    carModel: ride.carModel,
    pickup: ride.pickup,
    dest: ride.dest,
    distanceKm: ride.distanceKm,
    etaMin: ride.etaMin,
    finishAt: ride.finishAt,
    path: ride.routePath ?? [],
    price: ride.price,
    status: ride.status,
    createdAt: ride.createdAt,
    trafficLevel: ride.trafficLevel ?? 'unknown',
    pickupDelayMin: ride.pickupDelayMin ?? 0,
    trafficPreferred: ride.trafficPreferred ?? false,
  };
}

export function buildRoutes(source: DriverSource, defaults: { radiusKm: number; roads: RoadRouter }) {
  const router = Router();

  /** Догоняем статус поездок, которые закончились, пока сервиса «не видели». */
  async function settleRide(ride: RideDoc): Promise<RideDoc> {
    if (ride.status === 'accepted' && new Date(ride.finishAt).getTime() <= Date.now()) {
      ride.status = 'completed';
      await ride.save();
      await source.release(String(ride.driverId));
    }
    return ride;
  }

  router.get(
    '/drivers/near',
    asyncHandler(async (request, response) => {
      const query = request.query as Record<string, string | undefined>;
      const lat = num({ lat: query.lat }, 'lat', { min: -90, max: 90 })!;
      const lon = num({ lon: query.lon }, 'lon', { min: -180, max: 180 })!;
      const radiusKm = num({ radiusKm: query.radiusKm ?? String(defaults.radiusKm) }, 'radiusKm', { min: 0.2, max: 50 })!;
      // Круг видимой области карты: дальше его границ машины на экране нет, и отдавать
      // их незачем — при парке по всей России это разница между 5 и 500 строками ответа.
      const viewRadiusKm = num({ viewRadiusKm: query.viewRadiusKm }, 'viewRadiusKm', { min: 0.2, max: 600, optional: true });
      const viewLat = num({ viewLat: query.viewLat }, 'viewLat', { min: -90, max: 90, optional: true });
      const viewLon = num({ viewLon: query.viewLon }, 'viewLon', { min: -180, max: 180, optional: true });
      const view =
        viewRadiusKm !== undefined && viewLat !== undefined && viewLon !== undefined
          ? { center: { lat: viewLat, lon: viewLon }, radiusKm: viewRadiusKm }
          : undefined;
      const drivers = await source.listNear({ lat, lon }, radiusKm, view ?? undefined);
      response.json({ center: { lat, lon }, radiusKm, ...(view ? { view } : {}), drivers });
    }),
  );

  router.get(
    '/stats',
    asyncHandler(async (_request, response) => {
      response.json(await source.stats());
    }),
  );

  /**
   * Линия между двумя точками: её рисует фронт до вызова машины, ею же trip-service
   * считает километры поездки. Без дорог под точками возвращает прямую и byRoad: false.
   */
  router.get(
    '/road',
    asyncHandler(async (request, response) => {
      const query = request.query as Record<string, string | undefined>;
      const from: LatLng = { lat: num(query, 'fromLat', { min: -90, max: 90 })!, lon: num(query, 'fromLon', { min: -180, max: 180 })! };
      const to: LatLng = { lat: num(query, 'toLat', { min: -90, max: 90 })!, lon: num(query, 'toLon', { min: -180, max: 180 })! };
      response.json({ from, to, ...(await roadBetween(defaults.roads, from, to)) });
    }),
  );

  /** Вызов машины: свободный водитель с лучшей подачей с учётом пробок бронируется под заказ. */
  router.post(
    '/rides',
    requireAuth,
    asyncHandler(async (request, response) => {
      const body = request.body as Record<string, unknown>;
      const pickup = point(body, 'pickup');
      const dest = point(body, 'dest');
      const radiusKm = num(body, 'radiusKm', { min: 0.2, max: 50, optional: true }) ?? defaults.radiusKm;

      const choice = await rankDrivers(source, defaults.roads, pickup, radiusKm);
      if (!choice.best) {
        response.status(409).json({ error: `Свободных водителей в ${radiusKm} км нет. Попробуйте увеличить радиус.` });
        return;
      }

      // id заказа известен до вставки: водитель резервируется сразу под ним,
      // ему же прокладывается маршрут подачи и поездки.
      const rideId = new mongoose.Types.ObjectId();
      const order = [
        choice.best,
        ...choice.ranked
          .filter((entry) => entry.driver.id !== choice.best!.driver.id)
          .sort((a, b) => a.adjustedMin - b.adjustedMin || a.distanceKm - b.distanceKm),
      ];
      let acquired: Acquisition | undefined;
      let selected: RankedDriver | undefined;
      for (const candidate of order) {
        const result = await source.acquire(candidate.driver.id, rideId.toString(), [pickup, dest]);
        if (result) {
          acquired = result;
          selected = candidate;
          break;
        }
      }
      if (!acquired || !selected) throw new HttpError(409, 'Все подходящие водители только что уехали, попробуйте ещё раз');
      const { driver, route } = acquired;

      // С OSRM берём реальную длину улиц и его оценку времени; без него — прямая и скорость водителя.
      const speed = driver.speedKmh || 45;
      const straightKm = haversineKm(pickup.lat, pickup.lon, dest.lat, dest.lon);
      const toPickup = route?.legs[0] ?? { distanceKm: selected.distanceKm, durationMin: (selected.distanceKm / speed) * 60 };
      const rideLeg = route?.legs[1] ?? { distanceKm: straightKm, durationMin: (straightKm / speed) * 60 };

      // Полный маршрут режем по точке посадки: пробки на подаче и в поездке считаются отдельно.
      const split = route ? splitRouteAt(route.points, toPickup.distanceKm) : undefined;
      const pickupTraffic =
        split && split[0].length >= 2 ? scoreTraffic(split[0], toPickup.durationMin, choice.snapshot) : selected.traffic;
      const rideTraffic =
        split && split[1].length >= 2
          ? scoreTraffic(split[1], rideLeg.durationMin, choice.snapshot)
          : scoreTraffic([pickup, dest], rideLeg.durationMin, choice.snapshot);

      const freeFlowPickupMin = Math.max(1, Math.round(toPickup.durationMin));
      const etaMin = Math.max(1, freeFlowPickupMin + pickupTraffic.delayMin);
      const pickupDelayMin = Math.max(0, etaMin - freeFlowPickupMin);
      const freeFlowRideMin = Math.max(1, Math.round(rideLeg.durationMin));
      const rideMinutes = Math.max(1, freeFlowRideMin + rideTraffic.delayMin);
      const finishAt = new Date(Date.now() + (etaMin + rideMinutes) * 60_000);
      const trafficPreferred =
        choice.nearest !== undefined &&
        selected.driver.id !== choice.nearest.driver.id &&
        choice.nearest.traffic.level !== 'unknown' &&
        choice.nearest.traffic.factor > 1.02;

      try {
        const ride = await Ride.create({
          _id: rideId,
          userId: request.auth!.id,
          driverId: driver.id,
          driverName: driver.name,
          plate: driver.car.plate,
          carModel: driver.car.model,
          pickup: { lat: pickup.lat, lon: pickup.lon },
          dest: { lat: dest.lat, lon: dest.lon },
          distanceKm: Math.round(rideLeg.distanceKm * 10) / 10,
          etaMin,
          finishAt,
          routePath: decimate(route?.points ?? [], 150),
          price: driver.freeRide ? 0 : Math.round(driver.pricePerKm * rideLeg.distanceKm * 100) / 100,
          trafficLevel: pickupTraffic.level,
          pickupDelayMin,
          trafficPreferred,
        });
        if (trafficPreferred) {
          log.info('Машина выбрана с учётом пробок', {
            nearest: choice.nearest?.driver.car.plate,
            selected: driver.car.plate,
            nearestMin: choice.nearest ? Math.round(choice.nearest.adjustedMin * 10) / 10 : undefined,
            selectedMin: Math.round(selected.adjustedMin * 10) / 10,
            level: pickupTraffic.level,
            delayMin: pickupDelayMin,
          });
        }
        response.status(201).json({ ride: toRide(ride as RideDoc), driver, etaMin, rideMinutes });
      } catch (error) {
        await source.release(driver.id);
        throw error;
      }
    }),
  );

  router.get(
    '/rides',
    requireAuth,
    asyncHandler(async (request, response) => {
      const rides = await Ride.find({ userId: request.auth!.id }).sort({ createdAt: -1 }).limit(50);
      for (const ride of rides) await settleRide(ride as RideDoc);
      response.json(rides.map(toRide));
    }),
  );

  router.get(
    '/rides/:id',
    requireAuth,
    asyncHandler(async (request, response) => {
      if (!mongoose.Types.ObjectId.isValid(request.params.id!)) throw new HttpError(400, 'Некорректный id заказа');
      const ride = await Ride.findById(request.params.id) as RideDoc | null;
      if (!ride) throw new HttpError(404, 'Заказ не найден');
      if (ride.userId !== request.auth!.id) throw new HttpError(403, 'Заказ видит только его владелец');
      response.json(toRide(await settleRide(ride)));
    }),
  );

  router.post(
    '/rides/:id/cancel',
    requireAuth,
    asyncHandler(async (request, response) => {
      if (!mongoose.Types.ObjectId.isValid(request.params.id!)) throw new HttpError(400, 'Некорректный id заказа');
      const ride = await Ride.findById(request.params.id) as RideDoc | null;
      if (!ride) throw new HttpError(404, 'Заказ не найден');
      if (ride.userId !== request.auth!.id) throw new HttpError(403, 'Отменить заказ может только его владелец');
      if (ride.status !== 'accepted') throw new HttpError(409, `Заказ уже ${ride.status}`);

      ride.status = 'cancelled';
      await ride.save();
      await source.release(String(ride.driverId));
      response.json(toRide(ride));
    }),
  );

  return router;
}
