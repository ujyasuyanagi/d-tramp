import { GraphQLError } from 'graphql';
import { HttpError, type AuthUser } from '@dtramp/shared';
import { createLoaders, map, toBooking, toDriver, toRide, toTrip, toUser, trips, users, type Json, type Loaders } from './clients';

export interface Context {
  token?: string;
  auth?: AuthUser;
  loaders: Loaders;
}

export function createContext(headerToken?: string, auth?: AuthUser): Context {
  return { token: headerToken, auth, loaders: createLoaders(headerToken) };
}

function authorized(context: Context): string {
  if (!context.token || !context.auth) throw new GraphQLError('Требуется авторизация', { extensions: { code: 'UNAUTHENTICATED' } });
  return context.token;
}

async function cancelAndRefund(rideId: string, token: string) {
  const ride = await map.cancelRide(rideId, token);
  if (ride.price > 0 && ride.paymentVersion !== 1) {
    throw new HttpError(409, 'Заказ отменён. Возврат по старому заказу требует ручной проверки баланса.');
  }
  try {
    await users.refundBalance(rideId, token);
    return await map.confirmRefund(rideId, token);
  } catch {
    throw new HttpError(502, 'Заказ отменён, но возврат не подтверждён. Повторите возврат во вкладке «Мои».');
  }
}

const resolvers: Record<string, Record<string, (...args: any[]) => unknown>> = {
  Query: {
    health: () => ({ ok: true, service: 'api-gateway' }),

    me: (_parent: Json, _args: Json, context: Context) => users.me(authorized(context)).then(toUser),

    user: (_parent: Json, args: { id: string }, context: Context) => context.loaders.user.load(args.id).then((user) => (user ? toUser(user) : null)),

    trip: (_parent: Json, args: { id: string }, context: Context) => context.loaders.trip.load(args.id).then((trip) => (trip ? toTrip(trip) : null)),

    trips: (_parent: Json, args: Json, context: Context) => trips.search(args, context.token).then((rows) => rows.map(toTrip)),

    myTrips: (_parent: Json, _args: Json, context: Context) => trips.mine(authorized(context)).then((rows) => rows.map(toTrip)),

    bookings: (_parent: Json, args: { tripId?: string }, context: Context) =>
      trips.bookings({ tripId: args.tripId }, authorized(context)).then((rows) => rows.map(toBooking)),

    driversNear: (_parent: Json, args: { lat: number; lon: number; radiusKm?: number; viewLat?: number; viewLon?: number; viewRadiusKm?: number }) =>
      map.near(args).then((payload) => ({ ...payload, drivers: (payload.drivers as Json[]).map(toDriver) })),

    mapStats: () => map.stats(),

    roadRoute: (_parent: Json, args: { from: Json; to: Json }) => map.road(args),

    rides: (_parent: Json, _args: Json, context: Context) => map.rides(authorized(context)).then((rows) => rows.map(toRide)),

    ride: async (_parent: Json, args: { id: string }, context: Context) => toRide(await map.ride(args.id, authorized(context))),
  },

  Mutation: {
    register: (_parent: Json, args: { input: Json }) => users.register(args.input).then((payload) => ({ token: payload.token, user: toUser(payload.user) })),

    login: (_parent: Json, args: { input: Json }) => users.login(args.input).then((payload) => ({ token: payload.token, user: toUser(payload.user) })),

    updateProfile: (_parent: Json, args: { input: Json }, context: Context) => users.updateMe(args.input, authorized(context)).then(toUser),

    createTrip: async (_parent: Json, args: { input: Json }, context: Context) => {
      // километры поездки считает профиль дорог, а не прямая; молча остаёмся на
      // прямой, если map-service молчит — публикация не должна из-за этого падать
      const road = await map.road({ from: args.input.from, to: args.input.to }).catch(() => undefined);
      const input = { ...args.input, distanceKm: road?.byRoad ? road.distanceKm : undefined };
      return toTrip(await trips.create(input, authorized(context)));
    },

    cancelTrip: (_parent: Json, args: { id: string }, context: Context) => trips.cancel(args.id, authorized(context)).then(toTrip),

    bookTrip: (_parent: Json, args: { tripId: string; seats: number }, context: Context) => trips.book(args.tripId, args.seats, authorized(context)).then(toBooking),

    cancelBooking: (_parent: Json, args: { id: string }, context: Context) => trips.cancelBooking(args.id, authorized(context)).then(toBooking),

    requestRide: async (_parent: Json, args: { input: Json }, context: Context) => {
      const token = authorized(context);
      // Деньги списываются в момент вызова, а не по выходу из машины: пустой кошелёк
      // отсекаем до того, как под заказ зарезервируется водитель.
      const wallet = await users.me(token);
      if (Number(wallet.balance ?? 0) < 1) throw new HttpError(402, 'Баланс пуст — пополните кошелёк, чтобы вызвать машину');
      const result = await map.requestRide(args.input, token);
      // Цена известна уже здесь (pricePerKm × километры по дороге, 0 при акции freeRide),
      // поэтому это точное списание, а не аванс: поездка оплачена с первой секунды.
      const price = Number(result.ride?.price ?? 0);
      if (price > 0) {
        try {
          await users.debitBalance(price, String(result.ride.id), token);
        } catch (error) {
          // Не хватило на точную цену (или два заказа делят один баланс) — заказ не оплачен,
          // значит его не должно быть: освобождаем водителя и просим пополнить кошелёк.
          // Даже при потерянном ответе списание могло состояться: отмена возвращает
          // фактически списанное и блокирует запоздавшее списание этого заказа.
          await cancelAndRefund(String(result.ride.id), token);
          if (!(error instanceof HttpError) || error.status !== 409) throw error;
          throw new HttpError(402, `Недостаточно средств: поездка стоит ${Math.round(price)} ₽, пополните кошелёк`);
        }
      }
      return {
        ride: toRide(result.ride),
        driver: toDriver(result.driver),
        etaMin: result.etaMin,
        rideMinutes: result.rideMinutes,
      };
    },

    cancelRide: async (_parent: Json, args: { id: string }, context: Context) => {
      const token = authorized(context);
      return toRide(await cancelAndRefund(args.id, token));
    },

    boardRide: (_parent: Json, args: { id: string }, context: Context) => map.boardRide(args.id, authorized(context)).then(toRide),

    /** Выход — только закрытие заказа: цена списана ещё при вызове, здесь денег не трогаем. */
    exitRide: (_parent: Json, args: { id: string }, context: Context) => map.exitRide(args.id, authorized(context)).then(toRide),

    topUpBalance: (_parent: Json, args: { amount: number }, context: Context) => users.topUpBalance(args.amount, authorized(context)).then(toUser),
  },

  Trip: {
    driver: (trip: Json, _args: Json, context: Context) => context.loaders.user.load(String(trip.driverId)).then((user) => (user ? toUser(user) : null)),
  },

  Booking: {
    trip: (booking: Json, _args: Json, context: Context) => context.loaders.trip.load(String(booking.tripId)).then((trip) => (trip ? toTrip(trip) : null)),
    passenger: (booking: Json, _args: Json, context: Context) => context.loaders.user.load(String(booking.userId)).then((user) => (user ? toUser(user) : null)),
  },
};

/** Сообщения сервисов (в т.ч. «Недостаточно свободных мест») должны доходить до клиента, а не прятаться за Internal server error. */
function asGraphQLError(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) return error;
  const status = error instanceof HttpError ? error.status : undefined;
  const code =
    status === 401 ? 'UNAUTHENTICATED'
    : status === 403 ? 'FORBIDDEN'
    : status === 404 ? 'NOT_FOUND'
    : status === 409 ? 'CONFLICT'
    : status && status < 500 ? 'BAD_USER_INPUT'
    : 'INTERNAL_SERVER_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return new GraphQLError(message, { extensions: { code, ...(status ? { status } : {}) } });
}

function wrap(field: (...args: any[]) => unknown) {
  return async (...args: Parameters<typeof field>) => {
    try {
      return await field(...args);
    } catch (error) {
      throw asGraphQLError(error);
    }
  };
}

for (const type of Object.values(resolvers)) {
  for (const [field, handler] of Object.entries(type)) {
    type[field] = wrap(handler);
  }
}

export { resolvers };
