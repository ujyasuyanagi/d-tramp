import { inflateSync } from 'node:zlib';
import { log } from '@dtramp/shared';
import type { LatLng } from './router';

/**
 * Источник дорожной обстановки — тот же растровый слой, который фронт рисует поверх карты:
 * transparent PNG от Static API с зелёными/жёлтыми/красными полосами дорог. Отдельного
 * free API с пробками по сегментам нет, поэтому из растра берутся цвета вдоль полилинии
 * OSRM. Это оценка, а не официальное время проезда, но для выбора машины её достаточно.
 */

export type TrafficLevel = 'free' | 'moderate' | 'heavy' | 'unknown';

export interface TrafficScore {
  level: TrafficLevel;
  /** Во сколько раз дольше свободного потока; 1 — данных нет или дорога свободна. */
  factor: number;
  delayMin: number;
  /** Доля найденных цветных пикселей среди точек маршрута. */
  coverage: number;
  /** Доля красных участков среди найденных. */
  jamShare: number;
  samples: number;
}

export interface TrafficSnapshot {
  center: LatLng;
  zoom: number;
  width: number;
  height: number;
  /** RGBA, по 4 байта на пиксель. */
  pixels: Buffer;
}

const RASTER_ENDPOINT = 'https://static-maps.yandex.ru/1.x/';
const WIDTH = 650;
const HEIGHT = 450;
const MIN_PNG_BYTES = 15_000;
const MAX_PNG_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 90_000;
const FAILURE_TTL_MS = 20_000;
const CACHE_LIMIT = 8;
const SAMPLE_STEP_PX = 5;
const SEARCH_RADIUS_PX = 3;
const MIN_SAMPLES = 3;
const MIN_COVERAGE = 0.35;
const COLOR_LIMIT = 70;
const MIN_ALPHA = 96;

const ENABLED = process.env.MAP_TRAFFIC !== 'off';

const COLOR_WEIGHT: Record<'free' | 'moderate' | 'heavy', number> = {
  free: 1,
  moderate: 1.35,
  heavy: 2.4,
};

const COLOR_REFERENCES = [
  { level: 'free', r: 94, g: 205, b: 76 },
  { level: 'moderate', r: 255, g: 187, b: 51 },
  { level: 'heavy', r: 230, g: 90, b: 70 },
] as const;

const UNKNOWN: TrafficScore = {
  level: 'unknown',
  factor: 1,
  delayMin: 0,
  coverage: 0,
  jamShare: 0,
  samples: 0,
};

const cache = new Map<string, { snapshot: TrafficSnapshot | null; expires: number }>();
const inFlight = new Map<string, Promise<TrafficSnapshot | null>>();
let lastWarningAt = 0;

export function trafficKind(): string {
  return ENABLED ? 'yandex-static' : 'off';
}

/**
 * Снимок вокруг точки: один запрос на всех кандидатов. Кэш короткий — Яндекс обновляет
 * слой каждые несколько минут, а при пустом ответе не хочется долбить API на каждый заказ.
 */
export async function getTrafficSnapshot(center: LatLng, radiusKm: number): Promise<TrafficSnapshot | null> {
  if (!ENABLED) return null;

  const zoom = zoomForRadius(center, radiusKm);
  const at = { lat: round(center.lat, 4), lon: round(center.lon, 4) };
  const key = `${at.lat.toFixed(4)},${at.lon.toFixed(4)},${zoom}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached) {
    if (cached.expires > now) return cached.snapshot;
    cache.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = fetchSnapshot(at, zoom)
    .then((snapshot) => {
      cache.set(key, { snapshot, expires: Date.now() + CACHE_TTL_MS });
      trimCache();
      return snapshot;
    })
    .catch((error: unknown) => {
      warn(`Слой пробок недоступен: ${error instanceof Error ? error.message : String(error)}`);
      cache.set(key, { snapshot: null, expires: Date.now() + FAILURE_TTL_MS });
      trimCache();
      return null;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

/**
 * Средневзвешенная задержка вдоль маршрута. Точки идут равномерно по пикселям, поэтому
 * короткий красный перегон не растягивается на всю поездку.
 */
export function scoreTraffic(points: LatLng[], baseDurationMin: number, snapshot: TrafficSnapshot | null): TrafficScore {
  if (!snapshot || points.length === 0) return UNKNOWN;

  const samples = sampleRoute(points, snapshot);
  if (samples.length < MIN_SAMPLES) return { ...UNKNOWN, samples: samples.length };

  const counts = { free: 0, moderate: 0, heavy: 0 };
  let found = 0;
  for (const sample of samples) {
    const level = nearestColor(snapshot, sample.x, sample.y);
    if (!level) continue;
    counts[level] += 1;
    found += 1;
  }

  const coverage = found / samples.length;
  if (found < MIN_SAMPLES || coverage < MIN_COVERAGE) {
    return { ...UNKNOWN, coverage: round(coverage, 3), samples: samples.length };
  }

  const factor = round((counts.free + counts.moderate * COLOR_WEIGHT.moderate + counts.heavy * COLOR_WEIGHT.heavy) / found, 2);
  const jamShare = round(counts.heavy / found, 3);
  const delayMin = Math.max(0, Math.round(Math.max(0, baseDurationMin) * (factor - 1)));
  const level: TrafficLevel =
    jamShare >= 0.2 || factor >= 1.45 ? 'heavy' : factor >= 1.1 ? 'moderate' : 'free';

  return {
    level,
    factor,
    delayMin,
    coverage: round(coverage, 3),
    jamShare,
    samples: samples.length,
  };
}

/** Насколько крупный план нужен, чтобы круг поиска целиком попал в кадр 650×450. */
function zoomForRadius(center: LatLng, radiusKm: number): number {
  const latitude = Math.max(-85, Math.min(85, center.lat));
  const halfHeightAtZoomZero = (HEIGHT / 2) * 156_543.03392 * Math.cos((latitude * Math.PI) / 180);
  const targetMeters = Math.max(500, radiusKm * 1000 * 1.2);
  const zoom = Math.floor(Math.log2(halfHeightAtZoomZero / targetMeters));
  return Math.max(10, Math.min(13, zoom));
}

/**
 * Точки вдоль полилинии с шагом ~5 px. Вершины OSRM стоят через несколько метров,
 * но прямая-фолбэк (без роутера) состоит из двух точек — её тоже нужно прошагать,
 * иначе на короткой подаче не наберётся минимум образцов.
 */
function sampleRoute(points: LatLng[], snapshot: TrafficSnapshot): { x: number; y: number }[] {
  const center = project(snapshot.center, snapshot.zoom);
  const originX = center.x - snapshot.width / 2;
  const originY = center.y - snapshot.height / 2;
  const samples: { x: number; y: number }[] = [];
  let previous: { x: number; y: number } | undefined;

  for (const point of points) {
    const projected = project(point, snapshot.zoom);
    const pixel = { x: projected.x - originX, y: projected.y - originY };
    if (!previous) {
      samples.push(pixel);
    } else {
      const span = Math.hypot(pixel.x - previous.x, pixel.y - previous.y);
      const steps = Math.max(1, Math.ceil(span / SAMPLE_STEP_PX));
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        samples.push({
          x: previous.x + (pixel.x - previous.x) * ratio,
          y: previous.y + (pixel.y - previous.y) * ratio,
        });
      }
    }
    previous = pixel;
  }

  return samples;
}

function nearestColor(snapshot: TrafficSnapshot, x: number, y: number): 'free' | 'moderate' | 'heavy' | null {
  const startX = Math.round(x);
  const startY = Math.round(y);
  if (
    startX < -SEARCH_RADIUS_PX ||
    startY < -SEARCH_RADIUS_PX ||
    startX > snapshot.width + SEARCH_RADIUS_PX ||
    startY > snapshot.height + SEARCH_RADIUS_PX
  ) {
    return null;
  }

  let best: 'free' | 'moderate' | 'heavy' | null = null;
  let bestDistance = SEARCH_RADIUS_PX * SEARCH_RADIUS_PX + 1;
  for (let dy = -SEARCH_RADIUS_PX; dy <= SEARCH_RADIUS_PX; dy += 1) {
    const pixelY = startY + dy;
    if (pixelY < 0 || pixelY >= snapshot.height) continue;
    for (let dx = -SEARCH_RADIUS_PX; dx <= SEARCH_RADIUS_PX; dx += 1) {
      const pixelX = startX + dx;
      if (pixelX < 0 || pixelX >= snapshot.width) continue;
      const distance = dx * dx + dy * dy;
      if (distance >= bestDistance) continue;

      const offset = (pixelY * snapshot.width + pixelX) * 4;
      if (snapshot.pixels[offset + 3]! < MIN_ALPHA) continue;
      const color = classify(snapshot.pixels[offset]!, snapshot.pixels[offset + 1]!, snapshot.pixels[offset + 2]!);
      if (!color) continue;
      best = color;
      bestDistance = distance;
    }
  }
  return best;
}

function classify(r: number, g: number, b: number): 'free' | 'moderate' | 'heavy' | null {
  let best: 'free' | 'moderate' | 'heavy' | null = null;
  let bestDistance = COLOR_LIMIT * COLOR_LIMIT;
  for (const reference of COLOR_REFERENCES) {
    const distance = (r - reference.r) ** 2 + (g - reference.g) ** 2 + (b - reference.b) ** 2;
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = reference.level;
    }
  }
  return best;
}

function project(point: LatLng, zoom: number): { x: number; y: number } {
  const world = 256 * 2 ** zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  const sin = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((point.lon + 180) / 360) * world,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
  };
}

async function fetchSnapshot(center: LatLng, zoom: number): Promise<TrafficSnapshot> {
  const url = `${RASTER_ENDPOINT}?lang=ru_RU&l=trf&ll=${center.lon.toFixed(6)},${center.lat.toFixed(6)}&z=${zoom}&size=${WIDTH},${HEIGHT}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'image/png' },
  });
  if (!response.ok) throw new Error(`Static API ответил ${response.status}`);

  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new Error(`Static API вернул ${type || 'не изображение'}`);

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_PNG_BYTES) throw new Error('слой пробок слишком большой');

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < MIN_PNG_BYTES) throw new Error('пустой слой');
  if (buffer.length > MAX_PNG_BYTES) throw new Error('слой пробок слишком большой');

  const decoded = decodePng(buffer);
  if (!decoded) throw new Error('не удалось разобрать PNG');
  return { center, zoom, width: decoded.width, height: decoded.height, pixels: decoded.pixels };
}

/** Минимальный PNG-декодер: Static API отдаёт 8-битный non-interlaced RGB/RGBA. */
function decodePng(buffer: Buffer): { width: number; height: number; pixels: Buffer } | null {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const chunks: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) return null;

    if (type === 'IHDR') {
      if (length < 13) return null;
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8]!;
      colorType = buffer[start + 9]!;
      interlace = buffer[start + 12]!;
    } else if (type === 'IDAT') {
      chunks.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (
    width !== WIDTH ||
    height !== HEIGHT ||
    bitDepth !== 8 ||
    interlace !== 0 ||
    (colorType !== 6 && colorType !== 2) ||
    chunks.length === 0
  ) {
    return null;
  }

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(chunks));
  } catch {
    return null;
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  let position = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = raw[position]!;
    position += 1;
    const current = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    if (filter > 4) return null;

    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels]! : 0;
      const up = previous[index]!;
      const upLeft = index >= channels ? previous[index - channels]! : 0;
      const value = current[index]!;
      let restored = value;
      if (filter === 1) restored = (value + left) & 0xff;
      else if (filter === 2) restored = (value + up) & 0xff;
      else if (filter === 3) restored = (value + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) restored = (value + paeth(left, up, upLeft)) & 0xff;
      current[index] = restored;
    }

    for (let column = 0; column < width; column += 1) {
      const source = column * channels;
      const target = (row * width + column) * 4;
      pixels[target] = current[source]!;
      pixels[target + 1] = current[source + 1]!;
      pixels[target + 2] = current[source + 2]!;
      pixels[target + 3] = channels === 4 ? current[source + 3]! : 255;
    }

    current.copy(previous);
  }

  return { width, height, pixels };
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

function trimCache() {
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function warn(message: string) {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  log.warn(message);
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
