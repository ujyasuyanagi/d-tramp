import DataLoader from 'dataloader';
import { callService, env } from '@dtramp/shared';

const USER_URL = env('USER_SERVICE_URL', 'http://localhost:4001');
const TRIP_URL = env('TRIP_SERVICE_URL', 'http://localhost:4002');
const MAP_URL = env('MAP_SERVICE_URL', 'http://localhost:4003');

export type Json = Record<string, any>;

const up = (value: unknown) => (value === undefined || value === null ? value : String(value).toUpperCase());
const down = (value: unknown) => (value === undefined || value === null ? value : String(value).toLowerCase());

const id = (raw: Json) => String(raw.id ?? raw._id);

export const toUser = (raw: Json) => ({ ...raw, id: id(raw), role: up(raw.role) });
export const toTrip = (raw: Json) => ({ ...raw, id: id(raw), status: up(raw.status) });
export const toBooking = (raw: Json) => ({ ...raw, id: id(raw), tripId: String(raw.tripId), status: up(raw.status) });
export const toDriver = (raw: Json) => ({ ...raw, id: id(raw), status: up(raw.status), car: { ...raw.car, regionLabel: raw.regionLabel } });
export const toRide = (raw: Json) => ({
  ...raw,
  id: id(raw),
  driverId: String(raw.driverId),
  status: up(raw.status),
  refundPending: Boolean(raw.refundPending),
  trafficLevel: up(raw.trafficLevel ?? 'unknown'),
  pickupDelayMin: Number(raw.pickupDelayMin ?? 0),
  trafficPreferred: Boolean(raw.trafficPreferred),
});

const qs = (params: Record<string, unknown>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

/** Тонкие клиенты к внутренним REST-сервисам. Токен пользователя пробрасывается как есть. */
export const users = {
  register: (input: Json, token?: string) =>
    callService<Json>(USER_URL, '/register', { method: 'POST', body: { ...input, role: down(input.role) }, token }),
  login: (input: Json, token?: string) => callService<Json>(USER_URL, '/login', { method: 'POST', body: input, token }),
  me: (token: string) => callService<Json>(USER_URL, '/me', { token }),
  updateMe: (input: Json, token: string) =>
    callService<Json>(USER_URL, '/me', { method: 'PATCH', body: { ...input, role: down(input.role) }, token }),
  topUpBalance: (amount: number, token: string) =>
    callService<Json>(USER_URL, '/me/balance/topup', { method: 'POST', body: { amount }, token }),
  debitBalance: (amount: number, rideId: string, token: string) =>
    callService<Json>(USER_URL, '/me/balance/debit', { method: 'POST', body: { amount, rideId }, token }),
  refundBalance: (rideId: string, token: string) =>
    callService<Json>(USER_URL, '/me/balance/refund', { method: 'POST', body: { rideId }, token }),
  byId: (userId: string, token?: string) => callService<Json>(USER_URL, `/users/${userId}`, { token }),
  batch: (userIds: readonly string[], token?: string) =>
    callService<Json[]>(USER_URL, '/users/batch', { method: 'POST', body: { ids: [...userIds] }, token }),
};

export const trips = {
  create: (input: Json, token: string) =>
    callService<Json>(TRIP_URL, '/trips', {
      method: 'POST',
      body: {
        from: input.from,
        to: input.to,
        dateTime: input.dateTime,
        seats: input.seats,
        price: input.price,
        comment: input.comment,
        distanceKm: input.distanceKm,
      },
      token,
    }),
  search: (args: Json, token?: string) => callService<Json[]>(TRIP_URL, `/trips${qs(args)}`, { token }),
  byId: (tripId: string, token?: string) => callService<Json>(TRIP_URL, `/trips/${tripId}`, { token }),
  batch: (tripIds: readonly string[], token?: string) =>
    callService<Json[]>(TRIP_URL, '/trips/batch', { method: 'POST', body: { ids: [...tripIds] }, token }),
  mine: (token: string) => callService<Json[]>(TRIP_URL, '/trips/mine', { token }),
  cancel: (tripId: string, token: string) => callService<Json>(TRIP_URL, `/trips/${tripId}/cancel`, { method: 'POST', token }),
  book: (tripId: string, seats: number, token: string) =>
    callService<Json>(TRIP_URL, `/trips/${tripId}/book`, { method: 'POST', body: { seats }, token }),
  bookings: (args: { tripId?: string }, token: string) => callService<Json[]>(TRIP_URL, `/bookings${qs(args)}`, { token }),
  cancelBooking: (bookingId: string, token: string) =>
    callService<Json>(TRIP_URL, `/bookings/${bookingId}/cancel`, { method: 'POST', token }),
};

export const map = {
  near: (args: { lat: number; lon: number; radiusKm?: number }, token?: string) =>
    callService<Json>(MAP_URL, `/drivers/near${qs(args)}`, { token }),
  road: (args: { from: Json; to: Json }, token?: string) =>
    callService<Json>(
      MAP_URL,
      `/road${qs({ fromLat: args.from.lat, fromLon: args.from.lon, toLat: args.to.lat, toLon: args.to.lon })}`,
      { token },
    ),
  stats: (token?: string) => callService<Json>(MAP_URL, '/stats', { token }),
  requestRide: (input: Json, token: string) => callService<Json>(MAP_URL, '/rides', { method: 'POST', body: input, token }),
  rides: (token: string) => callService<Json[]>(MAP_URL, '/rides', { token }),
  ride: (rideId: string, token: string) => callService<Json>(MAP_URL, `/rides/${rideId}`, { token }),
  cancelRide: (rideId: string, token: string) => callService<Json>(MAP_URL, `/rides/${rideId}/cancel`, { method: 'POST', token }),
  confirmRefund: (rideId: string, token: string) => callService<Json>(MAP_URL, `/rides/${rideId}/refund-complete`, { method: 'POST', token }),
  boardRide: (rideId: string, token: string) => callService<Json>(MAP_URL, `/rides/${rideId}/board`, { method: 'POST', token }),
  exitRide: (rideId: string, token: string) => callService<Json>(MAP_URL, `/rides/${rideId}/exit`, { method: 'POST', token }),
};

export interface Loaders {
  user: DataLoader<string, Json | null>;
  trip: DataLoader<string, Json | null>;
}

/**батчинг, чтобы список поездок не превращался в N запросов к user-service. */
export function createLoaders(token?: string): Loaders {
  return {
    user: new DataLoader(async (userIds) => {
      const found = await users.batch(userIds as string[], token).catch(() => [] as Json[]);
      const byId = new Map(found.map((user) => [String(user.id ?? user._id), user]));
      return userIds.map((userId) => byId.get(String(userId)) ?? null);
    }),
    trip: new DataLoader(async (tripIds) => {
      const found = await trips.batch(tripIds as string[], token).catch(() => [] as Json[]);
      const byId = new Map(found.map((trip) => [String(trip.id ?? trip._id), trip]));
      return tripIds.map((tripId) => byId.get(String(tripId)) ?? null);
    }),
  };
}
