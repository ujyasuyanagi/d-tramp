import { haversineKm, log } from '@dtramp/shared';

export interface LatLng {
  lat: number;
  lon: number;
}

export interface RoadLeg {
  distanceKm: number;
  durationMin: number;
}

export interface RoadRoute {
  /** Полилиния по дорогам, от точки отправления до последней точки остановки. */
  points: LatLng[];
  distanceKm: number;
  durationMin: number;
  /** Отрезки между переданными stop-точками: подача машины и поездка отдельно. */
  legs: RoadLeg[];
}

/**
 * Профиль дорог. `null` означает «роутер сейчас не отвечает» — вызывающий код
 * тогда едет по прямой, чтобы демо не ломалось без OSRM.
 */
export interface RoadRouter {
  readonly kind: 'osrm' | 'off';
  route(from: LatLng, stops: LatLng[]): Promise<RoadRoute | null>;
  snap(point: LatLng): Promise<LatLng | null>;
}

interface OsrmRouteResponse {
  code?: string;
  routes?: {
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
    legs?: { distance: number; duration: number }[];
  }[];
}

interface OsrmNearestResponse {
  code?: string;
  waypoints?: { location: [number, number]; distance: number }[];
}

const COOLDOWN_MS = 30_000;
const FAILURES_BEFORE_COOLDOWN = 3;

/** Клиент self-hosted OSRM (osrm-project): маршрут по реальным дорогам OSM. */
class OsrmRouter implements RoadRouter {
  readonly kind = 'osrm';
  private failures = 0;
  private cooldownUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 2_500,
  ) {}

  private async get<T>(path: string): Promise<T | null> {
    if (Date.now() < this.cooldownUntil) return null;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      const body = (await response.json().catch(() => undefined)) as { code?: string } | undefined;
      if (!response.ok || !body || body.code !== 'Ok') {
        throw new Error(`OSRM ответил ${response.status} ${body?.code ?? ''}`.trim());
      }
      this.failures = 0;
      return body as T;
    } catch (error) {
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_COOLDOWN) {
        this.failures = 0;
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
        log.warn('OSRM недоступен: водители едут по прямой, повтор через 30 с', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }

  async route(from: LatLng, stops: LatLng[]): Promise<RoadRoute | null> {
    if (!stops.length) return null;
    const coordinates = [from, ...stops].map((point) => `${point.lon},${point.lat}`).join(';');
    const body = await this.get<OsrmRouteResponse>(
      `/route/v1/driving/${coordinates}?overview=full&geometries=geojson`,
    );
    const found = body?.routes?.[0];
    if (!found) return null;
    return {
      points: found.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
      distanceKm: found.distance / 1000,
      durationMin: found.duration / 60,
      legs: (found.legs ?? [{ distance: found.distance, duration: found.duration }]).map((leg) => ({
        distanceKm: leg.distance / 1000,
        durationMin: leg.duration / 60,
      })),
    };
  }

  async snap(point: LatLng): Promise<LatLng | null> {
    const body = await this.get<OsrmNearestResponse>(`/nearest/v1/driving/${point.lon},${point.lat}?number=1`);
    const found = body?.waypoints?.[0];
    // Дальше 3 км — это не «ближайшая дорога», а точка в парке/на воде: не телепортируем туда машину.
    if (!found || found.distance > 3_000) return null;
    return { lat: found.location[1], lon: found.location[0] };
  }
}

/** Роутер «по прямой»: есть по умолчанию, когда OSRM не настроен. */
const offRouter: RoadRouter = {
  kind: 'off',
  route: async () => null,
  snap: async () => null,
};

export function createRoadRouter(): RoadRouter {
  const url = (process.env.OSRM_URL ?? '').trim().replace(/\/+$/, '');
  if (!url) return offRouter;
  return new OsrmRouter(url);
}

/**
 * Для движения нужны все вершины улицы, а для отрисовки в браузере — достаточно
 * ~150, иначе JSON заказа раздувается до сотен килобайт.
 */
export function decimate(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const picked: LatLng[] = [];
  for (let index = 0; index < max; index += 1) {
    const point = points[Math.floor(index * step)];
    if (point) picked.push(point);
  }
  const last = points[points.length - 1];
  if (last) picked.push(last);
  return picked;
}

/**
 * Режет общую полилинию на участки по расстоянию. OSRM отдаёт длины ног, но не их
 * геометрию, а для оценки пробок нужны точки каждой ноги отдельно.
 */
export function splitRouteAt(points: LatLng[], distanceKm: number): [LatLng[], LatLng[]] {
  if (points.length < 2 || distanceKm <= 0) return [[], points];

  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const stepKm = haversineKm(previous.lat, previous.lon, current.lat, current.lon);
    if (travelled + stepKm >= distanceKm) {
      return [points.slice(0, index + 1), points.slice(index)];
    }
    travelled += stepKm;
  }

  return [points, []];
}

export interface RoadPreview {
  /** false — дорог в графе под этими точками нет, линия и километры считать по прямой. */
  byRoad: boolean;
  distanceKm: number;
  durationMin: number;
  path: LatLng[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * «Туда ли нас прилепили»: OSRM не умеет отвечать «дорог нет» — он тянет концы
 * маршрута к ближайшим улицам в графе, и Тверь, которой в парке нет, окажется в Химках.
 */
export function routeEndsAt(route: RoadRoute, stops: LatLng[], maxDriftKm = 2): boolean {
  const from = stops[0];
  const to = stops[stops.length - 1];
  const first = route.points[0];
  const last = route.points[route.points.length - 1];
  if (!from || !to || !first || !last) return false;
  return (
    haversineKm(from.lat, from.lon, first.lat, first.lon) <= maxDriftKm &&
    haversineKm(to.lat, to.lon, last.lat, last.lon) <= maxDriftKm
  );
}

/**
 * Линия между двумя точками: предпросмотр маршрута и длина поездки.
 *
 * OSRM не отвечает «таких дорог нет» — он тихо прилепит Тверь к улице в Химках, если
 * граф собран только по Москве, и выдаст 17 км вместо 180. Поэтому проверяем, куда
 * реально попали концы, и любую подозрительную длину меняем на честную прямую.
 */
export async function roadBetween(roads: RoadRouter, from: LatLng, to: LatLng): Promise<RoadPreview> {
  const straightKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
  const fallback = (): RoadPreview => ({
    byRoad: false,
    distanceKm: round1(straightKm),
    // 60 км/ч: минут ровно столько же, сколько километров
    durationMin: Math.max(1, Math.round(straightKm)),
    path: [from, to],
  });

  const route = await roads.route(from, [to]);
  const leg = route?.legs[0];
  if (!route || !leg || !routeEndsAt(route, [from, to])) return fallback();
  // 2 км — дальше «ближайшей дороги» уже нет, это другой город без дорог в графе.
  if (leg.distanceKm < straightKm * 0.98) return fallback();

  return {
    byRoad: true,
    distanceKm: round1(leg.distanceKm),
    durationMin: Math.max(1, Math.round(leg.durationMin)),
    path: decimate(route.points, 150),
  };
}
