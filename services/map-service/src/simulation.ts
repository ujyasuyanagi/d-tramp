import mongoose from 'mongoose';
import { destinationPoint, bearingDeg, haversineKm, log } from '@dtramp/shared';
import type { Acquisition, DriverSource, FreeDriver, ViewCircle } from './driver-source';
import { VDriver, type DriverView } from './models';
import { spreadDrivers, type CitySpawn } from './cities';
import { generatePlate, regionLabelOf } from './plates';
import { createRng, type Rng } from './rand';
import type { LatLng, RoadRouter, RoadRoute } from './router';
import { createRoadRouter, routeEndsAt } from './router';

export interface SimulationConfig {
  /** Города парка: каждый водитель живёт, ездит и получает номера своего города. */
  cities: CitySpawn[];
  count: number;
  /** Радиус поиска машины по умолчанию — тот же пунктирный круг на карте, км. */
  radiusKm: number;
  /** Сколько машин должно быть вокруг точки поиска; меньше — перегоняем ближний парк. */
  minNear: number;
  tickMs: number;
  seed?: number;
}

/**
 * Как далеко от точки поиска можно перегнать свободную машину, чтобы занять её.
 * Соседние города Москвы (Химки ↔ МКАД) проходят, Воронеж — нет: телепорт на 500 км
 * выглядит не как перегон парка, а как ошибка симуляции.
 */
const REBALANCE_MAX_KM = 120;

/** Как часто свободная машина уезжает «в заказ» — вероятность в секунду на одну машину. */
const BUSY_DRIFT_PER_SECOND = 0.001;

/** Закон распределения точки в круге: 'area' — равномерно по площади, 'falloff' — плотнее к центру. */
type PointLaw = 'area' | 'falloff';

interface SimDriver {
  id: string;
  name: string;
  car: { model: string; plate: string };
  rating: number;
  lat: number;
  lon: number;
  status: 'free' | 'busy';
  pricePerKm: number;
  freeRide: boolean;
  speedKmh: number;
  heading: number;
  target: { lat: number; lon: number };
  /** Промежуточные вершины дороги между текущей позицией и target. */
  path: LatLng[];
  /** «Дом»: город, вокруг которого машина ищет следующий заказ. */
  home: CitySpawn;
  busyUntil?: Date;
  rideId?: string;
}

const FIRST_NAMES = ['Алексей', 'Дмитрий', 'Иван', 'Сергей', 'Андрей', 'Николай', 'Павел', 'Максим', 'Ольга', 'Мария', 'Анна', 'Екатерина', 'Татьяна', 'Юлия', 'Виктор', 'Роман'];
const CAR_MODELS = ['Lada Vesta', 'Lada Granta', 'Kia Rio', 'Hyundai Solaris', 'VW Polo', 'Skoda Rapid', 'Renault Logan', 'Nissan Almera', 'Toyota Camry', 'Haval Jolion', 'Geely Emgrand', 'Chery Tiggo 4', 'Ford Focus', 'Changan CS35'];

/** Сколько машин обслуживаем параллельно при посеве — OSRM не любит 60 запросов сразу. */
const ROAD_CHUNK = 6;
const SNAP_ATTEMPTS = 4;

function toView(driver: SimDriver, distanceKm?: number): DriverView {
  return {
    id: driver.id,
    name: driver.name,
    car: driver.car,
    rating: driver.rating,
    lat: Math.round(driver.lat * 1e6) / 1e6,
    lon: Math.round(driver.lon * 1e6) / 1e6,
    status: driver.status,
    pricePerKm: driver.pricePerKm,
    freeRide: driver.freeRide,
    speedKmh: Math.round(driver.speedKmh),
    ...(distanceKm === undefined ? {} : { distanceKm: Math.round(distanceKm * 100) / 100 }),
    regionLabel: regionLabelOf(driver.car.plate),
  };
}

/**
 * Виртуальные водители: парк распределён по городам (`cities.ts` — Москва, областные
 * города и столицы ЦФО), в своём городе машина живёт плотнее к центру, позиции привязаны
 * к дорогам; едет по реальным улицам — маршрут берёт у RoadRouter (OSRM), а без него по
 * геодезической. Источник состояний — память, MongoDB — снапшот для истории/скриншотов
 * (см. DriverSource про замену на реальный источник).
 */
export class SimulationDriverSource implements DriverSource {
  readonly kind = 'simulation';
  private readonly drivers = new Map<string, SimDriver>();
  private readonly rng: Rng;
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  private rebalancing = false;

  constructor(
    private readonly config: SimulationConfig,
    private readonly roads: RoadRouter = createRoadRouter(),
  ) {
    this.rng = createRng(config.seed);
  }

  async start() {
    this.seedDrivers();
    // collection — зеркало текущей симуляции: перед посевом убираем прошлый состав,
    // иначе после рестарта сервиса там копятся «призраки» предыдущих запусков.
    await VDriver.deleteMany({});
    await this.placeOnRoads();
    await this.persist();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.tickMs);
    this.timer.unref();
    log.info('Симуляция водителей запущена', {
      kind: this.kind,
      router: this.roads.kind,
      count: this.drivers.size,
      cities: this.config.cities.map((city) => `${city.name}:${this.countIn(city)}`).join(' '),
      tickMs: this.config.tickMs,
    });
  }

  private countIn(city: CitySpawn) {
    return [...this.drivers.values()].filter((driver) => driver.home.key === city.key).length;
  }

  /** Стартовые позиции — на улицах своего города, плотнее к центру; затем маршруты до целей. */
  private async placeOnRoads() {
    const drivers = [...this.drivers.values()];
    for (let offset = 0; offset < drivers.length; offset += ROAD_CHUNK) {
      await Promise.all(
        drivers.slice(offset, offset + ROAD_CHUNK).map(async (driver) => {
          const spot = await this.roadPoint(driver.home, driver.home.radiusKm, 'falloff');
          driver.lat = spot.lat;
          driver.lon = spot.lon;
          await this.retarget(driver);
        }),
      );
    }
    log.info('Водители расставлены по дорогам', { router: this.roads.kind, count: drivers.length });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private seedDrivers() {
    for (const home of spreadDrivers(this.config.count, this.config.cities)) {
      const id = new mongoose.Types.ObjectId().toString();
      const driver: SimDriver = {
        id,
        home,
        // Фамилий пока нет: согласовать род с именем — это задача гендерной морфологии,
        // а не курсовой, и без них «Ольга · Geely Emgrand» читается лучше, чем «Попов Ольга».
        name: this.rng.pick(FIRST_NAMES),
        car: { model: this.rng.pick(CAR_MODELS), plate: generatePlate(home.region, this.rng) },
        rating: Math.round(this.rng.range(4.1, 5) * 10) / 10,
        lat: home.lat,
        lon: home.lon,
        status: this.rng.chance(0.25) ? 'busy' : 'free',
        pricePerKm: this.rng.int(16, 34),
        freeRide: this.rng.chance(0.08),
        speedKmh: this.rng.range(28, 68),
        heading: this.rng.range(0, 360),
        target: this.randomPoint(home, home.radiusKm, 'area'),
        path: [],
      };
      if (driver.status === 'busy') driver.busyUntil = new Date(Date.now() + this.rng.range(2, 14) * 60_000);
      this.drivers.set(id, driver);
    }
  }

  /**
   * Точка в круге: 'area' — равномерно по площади (`r = R·√u`, иначе все липнут к центру),
   * 'falloff' — `r = R·u`, плотность убывает как 1/r: в центре машин больше, к краю парка реже.
   */
  private randomPoint(center: { lat: number; lon: number }, radiusKm: number, law: PointLaw = 'area') {
    const distance = radiusKm * (law === 'falloff' ? this.rng.float() : Math.sqrt(this.rng.float()));
    const bearing = this.rng.range(0, 360);
    return destinationPoint(center.lat, center.lon, bearing, distance);
  }

  /** Та же точка, но поставленная на ближайшую дорогу; без OSRM остаётся как есть. */
  private async roadPoint(center: { lat: number; lon: number }, radiusKm: number, law: PointLaw) {
    const guess = this.randomPoint(center, radiusKm, law);
    if (this.roads.kind === 'off') return guess;
    for (let attempt = 0; attempt < SNAP_ATTEMPTS; attempt += 1) {
      const onRoad = await this.roads.snap(attempt === 0 ? guess : this.randomPoint(center, radiusKm, law));
      if (onRoad) return onRoad;
    }
    return guess;
  }

  private async tick() {
    this.ticks += 1;
    const now = Date.now();
    const dtHours = this.config.tickMs / 3_600_000;

    for (const driver of this.drivers.values()) {
      if (driver.busyUntil && driver.busyUntil.getTime() <= now) {
        driver.busyUntil = undefined;
        if (!driver.rideId) driver.status = 'free';
      }

      // Вероятность на секунду, а не на тик: иначе уезжает в «занято» тем чаще, чем
      // чаще тикает симуляция, и парк при тике 500 мс выгорал до нескольких свободных.
      // 0.001/с при 3–12 мин занятости даёт примерно треть машин в работе — как в жизни.
      if (driver.status === 'free' && this.rng.chance(BUSY_DRIFT_PER_SECOND * (this.config.tickMs / 1000))) {
        driver.status = 'busy';
        driver.busyUntil = new Date(now + this.rng.range(3, 12) * 60_000);
      }

      if (driver.path.length === 0 && haversineKm(driver.lat, driver.lon, driver.target.lat, driver.target.lon) < 0.25) {
        // Доехала раньше, чем заказ закроется по finishAt: ждёт на месте. С новым retarget
        // машина ушла бы по своим делам, а зелёная линия заказа тянулась бы за ней косой.
        if (driver.rideId && driver.busyUntil && driver.busyUntil.getTime() > now) continue;
        await this.retarget(driver);
        continue;
      }

      this.move(driver, driver.speedKmh * dtHours * (driver.status === 'busy' ? 1 : 0.55));
    }

    if (this.ticks % 4 === 0) await this.persist();
  }

  /**
   * Новый пункт назначения в своём городе и маршрут до него; без роутера — прямая линия.
   * Маршруту с чужими концами не доверяем: если города нет в графе, OSRM прилепит его
   * улицы к ближайшему нашему городу, и машина поедет из Тамбова в Химки.
   */
  private async retarget(driver: SimDriver) {
    const target = this.randomPoint(driver.home, driver.home.radiusKm, 'area');
    const here = { lat: driver.lat, lon: driver.lon };
    const route = await this.roads.route(here, [target]);
    this.applyRoute(driver, route && routeEndsAt(route, [here, target]) ? route : null, target);
  }

  private applyRoute(driver: SimDriver, route: RoadRoute | null, fallback: LatLng) {
    const finish = route ? route.points[route.points.length - 1] : undefined;
    if (!route || !finish) {
      driver.target = fallback;
      driver.path = [];
      return;
    }
    driver.path = route.points.slice(1, -1);
    driver.target = finish;
  }

  /**
   * Шаг длиной stepKm вдоль маршрута: вершины дорог проходятся одна за другой,
   * остаток шага переносится на следующий участок — иначе машина притормаживала
   * бы у каждой точки полилинии.
   */
  private move(driver: SimDriver, stepKm: number) {
    let budget = stepKm;
    for (;;) {
      const aim = driver.path[0];
      if (!aim) break;
      const legKm = haversineKm(driver.lat, driver.lon, aim.lat, aim.lon);
      driver.heading = bearingDeg(driver.lat, driver.lon, aim.lat, aim.lon);
      if (legKm > budget) {
        const next = destinationPoint(driver.lat, driver.lon, driver.heading, budget);
        driver.lat = next.lat;
        driver.lon = next.lon;
        return;
      }
      driver.lat = aim.lat;
      driver.lon = aim.lon;
      driver.path.shift();
      budget -= legKm;
    }

    const toTargetKm = haversineKm(driver.lat, driver.lon, driver.target.lat, driver.target.lon);
    if (toTargetKm <= budget) {
      driver.lat = driver.target.lat;
      driver.lon = driver.target.lon;
      return;
    }
    if (budget > 0) {
      driver.heading = bearingDeg(driver.lat, driver.lon, driver.target.lat, driver.target.lon);
      const next = destinationPoint(driver.lat, driver.lon, driver.heading, budget);
      driver.lat = next.lat;
      driver.lon = next.lon;
    }
  }

  private async persist() {
    const operations = [...this.drivers.values()].map((driver) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(driver.id) },
        update: {
          $set: {
            name: driver.name,
            car: driver.car,
            rating: driver.rating,
            lat: driver.lat,
            lon: driver.lon,
            status: driver.status,
            pricePerKm: driver.pricePerKm,
            freeRide: driver.freeRide,
            speedKmh: Math.round(driver.speedKmh * 10) / 10,
            heading: Math.round(driver.heading),
            ...(driver.busyUntil ? { busyUntil: driver.busyUntil } : { busyUntil: null }),
            ...(driver.rideId ? { rideId: driver.rideId } : { rideId: null }),
          },
        },
        upsert: true,
      },
    }));
    try {
      await VDriver.bulkWrite(operations, { ordered: false });
    } catch (error) {
      log.warn('Не удалось сохранить снапшот водителей', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listNear(center: { lat: number; lon: number }, radiusKm: number, view?: ViewCircle): Promise<DriverView[]> {
    let near = this.collectNear(center, radiusKm);
    if (near.length < this.config.minNear) {
      await this.rebalance(center, radiusKm, near.length);
      near = this.collectNear(center, radiusKm);
    }
    if (!view || view.radiusKm <= radiusKm) return near;
    // Круг обзора шире круга поиска: показываем и тех, кто просто едет мимо по своим делам.
    const shown = new Set(near.map((driver) => driver.id));
    return [...near, ...this.collectNear(view.center, view.radiusKm).filter((driver) => !shown.has(driver.id))];
  }

  private collectNear(center: { lat: number; lon: number }, radiusKm: number): DriverView[] {
    return [...this.drivers.values()]
      .map((driver) => ({ driver, distanceKm: haversineKm(center.lat, center.lon, driver.lat, driver.lon) }))
      .filter((entry) => entry.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .map((entry) => toView(entry.driver, entry.distanceKm));
  }

  private nearestCity(center: { lat: number; lon: number }): CitySpawn {
    return this.config.cities.reduce(
      (best, city) => (haversineKm(center.lat, center.lon, city.lat, city.lon) < haversineKm(center.lat, center.lon, best.lat, best.lon) ? city : best),
      this.config.cities[0]!,
    );
  }

  /**
   * Парк живёт по городам, а машины ищут там, где пользователь. Если вокруг точки поиска
   * пусто — свободные машины переставляются на дороги рядом и получают этот город как новый
   * «дом»: прообраз реального rebalancing автопарка.
   * Гейт по «дому», а не по текущей позиции: позиция — величина блуждающая, и без него
   * successive перегонки уводят машину через весь парк (курские номера в центре Москвы).
   * Дальше REBALANCE_MAX_KM от якоря не гоним: перегон через всю область — телепорт, а не симуляция.
   */
  private async rebalance(center: { lat: number; lon: number }, radiusKm: number, nearCount: number) {
    if (this.rebalancing || this.config.cities.length === 0) return;
    const anchor = this.nearestCity(center);
    if (haversineKm(center.lat, center.lon, anchor.lat, anchor.lon) > REBALANCE_MAX_KM) return;
    this.rebalancing = true;
    try {
      const far = [...this.drivers.values()]
        .filter(
          (driver) =>
            driver.status === 'free' &&
            !driver.rideId &&
            haversineKm(anchor.lat, anchor.lon, driver.home.lat, driver.home.lon) <= REBALANCE_MAX_KM &&
            haversineKm(center.lat, center.lon, driver.lat, driver.lon) > radiusKm * 2,
        )
        .sort(
          (a, b) =>
            haversineKm(center.lat, center.lon, b.lat, b.lon) - haversineKm(center.lat, center.lon, a.lat, a.lon),
        )
        .slice(0, this.config.minNear - nearCount);
      if (!far.length) return;
      for (const driver of far) {
        driver.home = anchor;
        // 0.9, а не 1.5: поставленная за краем круга машина не засчитывается в nearCount,
        // и minNear не достигается никогда — перегон повторяется на каждом запросе.
        const spot = await this.roadPoint(center, radiusKm * 0.9, 'area');
        driver.lat = spot.lat;
        driver.lon = spot.lon;
        driver.path = [];
        await this.retarget(driver);
      }
      log.info('Свободные машины из окрестностей перегнаны к точке поиска', { moved: far.length, center, city: anchor.name });
      await this.persist();
    } finally {
      this.rebalancing = false;
    }
  }

  async nearestFree(center: { lat: number; lon: number }, radiusKm: number): Promise<FreeDriver | null> {
    const near = await this.listNear(center, radiusKm);
    const driver = near.find((candidate) => candidate.status === 'free');
    return driver ? { driver, distanceKm: driver.distanceKm ?? 0 } : null;
  }

  async acquire(driverId: string, rideId: string, stops: LatLng[]): Promise<Acquisition | null> {
    const driver = this.drivers.get(driverId);
    if (!driver || driver.status !== 'free') return null;

    const route = stops.length > 1 ? await this.roads.route({ lat: driver.lat, lon: driver.lon }, stops) : null;
    this.applyRoute(driver, route, stops[stops.length - 1] ?? driver);
    driver.status = 'busy';
    driver.rideId = rideId;
    // Подстраховка: заказ доживает до release() по своему finishAt, но если заказ
    // потеряется — водитель всё равно вернётся в пул.
    const minutes = route ? route.durationMin + 2 : (haversineKm(driver.lat, driver.lon, driver.target.lat, driver.target.lon) / driver.speedKmh) * 60 + 2;
    driver.busyUntil = new Date(Date.now() + minutes * 60_000);

    await this.persist();
    return { driver: toView(driver), route };
  }

  async release(driverId: string): Promise<void> {
    const driver = this.drivers.get(driverId);
    if (!driver) return;
    driver.status = 'free';
    driver.busyUntil = undefined;
    driver.rideId = undefined;
    await this.persist();
  }

  async stats() {
    const drivers = [...this.drivers.values()];
    const byRegion = new Map<string, number>();
    const byCity = new Map<string, number>();
    for (const driver of drivers) {
      const label = regionLabelOf(driver.car.plate);
      byRegion.set(label, (byRegion.get(label) ?? 0) + 1);
      byCity.set(driver.home.name, (byCity.get(driver.home.name) ?? 0) + 1);
    }
    return {
      kind: this.kind,
      router: this.roads.kind,
      total: drivers.length,
      free: drivers.filter((driver) => driver.status === 'free').length,
      busy: drivers.filter((driver) => driver.status === 'busy').length,
      cities: [...byCity.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byRegion: [...byRegion.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
}

/** Точка выбора источника водителей: real source подставляется здесь. */
export function createDriverSource(config: SimulationConfig, roads: RoadRouter = createRoadRouter()): DriverSource {
  const kind = process.env.DRIVER_SOURCE ?? 'simulation';
  if (kind !== 'simulation') {
    throw new Error(`Неизвестный DRIVER_SOURCE="${kind}". Доступно: simulation`);
  }
  return new SimulationDriverSource(config, roads);
}
