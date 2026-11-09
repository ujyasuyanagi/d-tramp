import type { DriverView } from './models';
import type { LatLng, RoadRoute } from './router';

export interface FreeDriver {
  driver: DriverView;
  /** км от точки пользователя до водителя. */
  distanceKm: number;
}

export interface Acquisition {
  driver: DriverView;
  /** Маршрут подачи+поездки по дорогам; null, если роутер недоступен (тогда прямая). */
  route: RoadRoute | null;
}

/**
 * Круг, который фронт показывает на экране. Отдельный от круга поиска: парк смотрят
 * там, куда смотрят, а машину ищут вокруг точки посадки.
 */
export interface ViewCircle {
  center: LatLng;
  radiusKm: number;
}

/**
 * Adapter: остальной сервис работает только с этим интерфейсом.
 * Симуляция (SimulationDriverSource) подменяется реальным источником —
 * приложением водителя или API карт — без изменения маршрутов и gateway.
 */
export interface DriverSource {
  readonly kind: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Машины круга поиска; `view` добавляет к ответу видимую на экране область —
   * distanceKm у всех считается от `center`, чтобы фронт одним числом отсекал круг поиска.
   */
  listNear(center: { lat: number; lon: number }, radiusKm: number, view?: ViewCircle): Promise<DriverView[]>;
  nearestFree(center: { lat: number; lon: number }, radiusKm: number): Promise<FreeDriver | null>;
  /**
   * Занять водителя под заказ и проложить ему путь по stop-точкам
   * (обычно [посадка, назначение]); null — если водитель уже уехал.
   */
  acquire(driverId: string, rideId: string, stops: LatLng[]): Promise<Acquisition | null>;
  /** Пассажир подтвердил посадку: машина снимается с ожидания у точки встречи. */
  board(driverId: string): Promise<void>;
  release(driverId: string): Promise<void>;
  /** Водитель доехал до точки посадки активного заказа (флаг держится до конца заказа). */
  arrivedAtPickup(driverId: string): Promise<boolean>;
  /** Заказная машина доехала до точки назначения — по этому закрываем подачу в `arrived`. */
  arrivedAtDestination(driverId: string): Promise<boolean>;
  stats(): Promise<{
    kind: string;
    router: string;
    total: number;
    free: number;
    busy: number;
    /** Машины по городам, где живёт парк. */
    cities: { name: string; count: number }[];
    byRegion: { label: string; count: number }[];
  }>;
}
