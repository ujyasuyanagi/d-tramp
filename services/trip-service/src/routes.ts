import { Router } from 'express';
import mongoose from 'mongoose';
import { HttpError, asyncHandler, haversineKm, num, optionalAuth, point, requireAuth, str } from '@dtramp/shared';
import { Booking, Trip } from './models';

const router = Router();

function objectId(value: string | undefined, what = 'id'): mongoose.Types.ObjectId {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) throw new HttpError(400, `Некорректный ${what}`);
  return new mongoose.Types.ObjectId(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Окно поиска: конкретный день либо все будущие поездки. */
function dayWindow(date?: string) {
  if (!date) return { $gte: new Date() };
  const start = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'date должен быть в формате YYYY-MM-DD');
  return { $gte: start, $lt: new Date(start.getTime() + 86_400_000) };
}

// ─── Поездки ────────────────────────────────────────────────────────────────

router.post(
  '/trips',
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = request.body as Record<string, unknown>;
    const from = point(body, 'from');
    const to = point(body, 'to');
    if (from.lat === to.lat && from.lon === to.lon) throw new HttpError(400, 'Точки отправления и назначения совпадают');

    const dateTime = new Date(str(body, 'dateTime')!);
    if (Number.isNaN(dateTime.getTime())) throw new HttpError(400, 'dateTime должен быть ISO-датой');
    if (dateTime.getTime() < Date.now() - 60_000) throw new HttpError(400, 'Дата поездки не может быть в прошлом');

    const seatsTotal = num(body, 'seats', { min: 1, max: 8, integer: true })!;
    // Шлюз прокладывает маршрут по дорогам и присылает длину; своя прямая — фолбэк,
    // когда профиля дорог нет (trip-service с map-service не знакомится напрямую).
    const roadKm = num(body, 'distanceKm', { min: 0.5, max: 20_000, optional: true });
    const trip = await Trip.create({
      driverId: request.auth!.id,
      from,
      to,
      dateTime,
      seatsTotal,
      seatsAvailable: seatsTotal,
      price: num(body, 'price', { min: 0, max: 100_000 })!,
      distanceKm: Math.round((roadKm ?? haversineKm(from.lat, from.lon, to.lat, to.lon)) * 10) / 10,
      comment: str(body, 'comment', { optional: true, max: 300 }),
    });
    response.status(201).json(trip);
  }),
);

/** Публичный поиск: название точки, дата, нужное число мест. */
router.get(
  '/trips',
  asyncHandler(async (request, response) => {
    const query = request.query as Record<string, string | undefined>;
    const filter: Record<string, unknown> = { status: 'scheduled', dateTime: dayWindow(query.date) };

    const seats = query.seats === undefined ? undefined : num({ seats: Number(query.seats) }, 'seats', { min: 1, max: 8, integer: true });
    if (seats) filter.seatsAvailable = { $gte: seats };
    if (query.driverId) filter.driverId = objectId(query.driverId, 'driverId').toString();
    if (query.from) filter['from.name'] = { $regex: escapeRegExp(query.from), $options: 'i' };
    if (query.to) filter['to.name'] = { $regex: escapeRegExp(query.to), $options: 'i' };

    const limit = num({ limit: query.limit ?? '50' }, 'limit', { min: 1, max: 200, integer: true })!;
    response.json(await Trip.find(filter).sort({ dateTime: 1 }).limit(limit));
  }),
);

router.get(
  '/trips/mine',
  requireAuth,
  asyncHandler(async (request, response) => {
    response.json(await Trip.find({ driverId: request.auth!.id }).sort({ dateTime: -1 }));
  }),
);

router.get(
  '/trips/:id',
  asyncHandler(async (request, response) => {
    const trip = await Trip.findById(objectId(request.params.id!));
    if (!trip) throw new HttpError(404, 'Поездка не найдена');
    response.json(trip);
  }),
);

router.post(
  '/trips/:id/cancel',
  requireAuth,
  asyncHandler(async (request, response) => {
    const id = objectId(request.params.id);
    const trip = await Trip.findById(id);
    if (!trip) throw new HttpError(404, 'Поездка не найдена');
    if (trip.driverId !== request.auth!.id) throw new HttpError(403, 'Отменить поездку может только её водитель');

    trip.status = 'cancelled';
    await trip.save();
    await Booking.updateMany({ tripId: id, status: 'confirmed' }, { status: 'cancelled' });
    response.json(trip);
  }),
);

// ─── Брони ──────────────────────────────────────────────────────────────────

async function seatsError(tripId: mongoose.Types.ObjectId): Promise<HttpError> {
  const trip = await Trip.findById(tripId);
  if (!trip) return new HttpError(404, 'Поездка не найдена');
  if (trip.status !== 'scheduled') return new HttpError(409, `Поездка уже ${trip.status}`);
  return new HttpError(409, 'Недостаточно свободных мест');
}

router.post(
  '/trips/:id/book',
  requireAuth,
  asyncHandler(async (request, response) => {
    const tripId = objectId(request.params.id);
    const userId = request.auth!.id;
    const seats = num(request.body as Record<string, unknown>, 'seats', { min: 1, max: 8, integer: true, optional: true }) ?? 1;

    const ownTrip = await Trip.exists({ _id: tripId, driverId: userId });
    if (ownTrip) throw new HttpError(403, 'Нельзя бронировать места в собственной поездке');

    if (await Booking.exists({ tripId, userId, status: 'confirmed' })) {
      throw new HttpError(409, 'Вы уже забронировали место в этой поездке');
    }

    // Атомарное списание мест: два пассажира не могут занять последнее место.
    const trip = await Trip.findOneAndUpdate(
      { _id: tripId, status: 'scheduled', seatsAvailable: { $gte: seats } },
      { $inc: { seatsAvailable: -seats } },
      { new: true },
    );
    if (!trip) throw await seatsError(tripId);

    try {
      const booking = await Booking.create({
        tripId,
        userId,
        seats,
        priceTotal: Math.round(trip.price * seats * 100) / 100,
      });
      response.status(201).json(booking);
    } catch (error) {
      await Trip.updateOne({ _id: tripId }, { $inc: { seatsAvailable: seats } });
      throw error;
    }
  }),
);

router.get(
  '/bookings',
  requireAuth,
  asyncHandler(async (request, response) => {
    const query = request.query as Record<string, string | undefined>;
    if (!query.tripId) {
      response.json(await Booking.find({ userId: request.auth!.id }).sort({ createdAt: -1 }));
      return;
    }
    // Список броней поездки доступен только её водителю.
    const tripId = objectId(query.tripId, 'tripId');
    const trip = await Trip.findById(tripId);
    if (!trip) throw new HttpError(404, 'Поездка не найдена');
    if (trip.driverId !== request.auth!.id) throw new HttpError(403, 'Брони поездки видит только её водитель');
    response.json(await Booking.find({ tripId }).sort({ createdAt: -1 }));
  }),
);

/** Пакетная выдача поездок — батчинг для GraphQL-шлюза (чтобы не делать N запросов). */
router.post(
  '/trips/batch',
  asyncHandler(async (request, response) => {
    const ids = (request.body as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) throw new HttpError(400, 'Поле "ids" должно быть массивом');
    const valid = ids.filter((value): value is string => typeof value === 'string' && mongoose.Types.ObjectId.isValid(value));
    const found = await Trip.find({ _id: { $in: valid } });
    const byId = new Map(found.map((trip) => [trip.id, trip]));
    // Порядок совпадает с запросом — так DataLoader корректно сопоставляет id.
    response.json(valid.map((value) => byId.get(value)).filter((trip) => trip !== undefined));
  }),
);

router.post(
  '/bookings/:id/cancel',
  requireAuth,
  asyncHandler(async (request, response) => {
    const booking = await Booking.findById(objectId(request.params.id));
    if (!booking) throw new HttpError(404, 'Бронь не найдена');
    if (booking.userId !== request.auth!.id) throw new HttpError(403, 'Отменить бронь может только её владелец');
    if (booking.status === 'cancelled') throw new HttpError(409, 'Бронь уже отменена');

    // Только один из параллельных запросов получает право вернуть места.
    const cancelled = await Booking.findOneAndUpdate(
      { _id: booking._id, userId: request.auth!.id, status: 'confirmed' },
      { $set: { status: 'cancelled' } },
      { new: true },
    );
    if (!cancelled) throw new HttpError(409, 'Бронь уже отменена');
    await Trip.updateOne({ _id: cancelled.tripId }, { $inc: { seatsAvailable: cancelled.seats } });
    response.json(cancelled);
  }),
);

/** Сводка для отладки и скриншотов. */
router.get(
  '/stats',
  optionalAuth,
  asyncHandler(async (_request, response) => {
    const [trips, bookings] = await Promise.all([Trip.estimatedDocumentCount(), Booking.estimatedDocumentCount()]);
    response.json({ trips, bookings });
  }),
);

export default router;
