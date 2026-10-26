import { HttpError } from './errors';

type Body = Record<string, unknown>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function str(body: Body, field: string, { min = 1, max = 300, optional = false } = {}): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new HttpError(400, `Поле "${field}" обязательно`);
  }
  if (typeof value !== 'string') throw new HttpError(400, `Поле "${field}" должно быть строкой`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new HttpError(400, `Поле "${field}" слишком короткое (мин. ${min})`);
  if (trimmed.length > max) throw new HttpError(400, `Поле "${field}" слишком длинное (макс. ${max})`);
  return trimmed;
}

export function email(body: Body, field = 'email'): string {
  const value = str(body, field, { min: 5 })!;
  if (!EMAIL_RE.test(value)) throw new HttpError(400, 'Некорректный email');
  return value.toLowerCase();
}

export function num(
  body: Body,
  field: string,
  { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, integer = false, optional = false } = {},
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new HttpError(400, `Поле "${field}" обязательно`);
  }
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : (value as number);
  if (typeof parsed !== 'number' || Number.isNaN(parsed)) throw new HttpError(400, `Поле "${field}" должно быть числом`);
  if (integer && !Number.isInteger(parsed)) throw new HttpError(400, `Поле "${field}" должно быть целым`);
  if (parsed < min || parsed > max) throw new HttpError(400, `Поле "${field}" вне диапазона [${min}; ${max}]`);
  return parsed;
}

export function oneOf<T extends string>(body: Body, field: string, allowed: readonly T[], fallback?: T): T {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `Поле "${field}" обязательно`);
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new HttpError(400, `Поле "${field}" должно быть одним из: ${allowed.join(', ')}`);
  }
  return value as T;
}

export interface GeoPoint {
  name?: string;
  lat: number;
  lon: number;
}

export function point(body: Body, field: string): GeoPoint {
  const value = body[field];
  if (typeof value !== 'object' || value === null) throw new HttpError(400, `Поле "${field}" обязательно`);
  const raw = value as Body;
  const lat = num(raw, 'lat', { min: -90, max: 90 })!;
  const lon = num(raw, 'lon', { min: -180, max: 180 })!;
  const name = typeof raw.name === 'string' ? raw.name.trim() : undefined;
  return { lat, lon, ...(name ? { name } : {}) };
}

export const ROLES = ['driver', 'passenger'] as const;
export type Role = (typeof ROLES)[number];
