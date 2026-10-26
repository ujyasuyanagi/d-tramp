import mongoose from 'mongoose';

export const DRIVER_STATUSES = ['free', 'busy'] as const;
export const RIDE_STATUSES = ['accepted', 'completed', 'cancelled'] as const;

const vdriverSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    car: {
      model: { type: String, required: true },
      plate: { type: String, required: true, unique: true },
    },
    rating: { type: Number, default: 4.7, min: 0, max: 5 },
    lat: { type: Number, required: true, index: true },
    lon: { type: Number, required: true, index: true },
    status: { type: String, enum: DRIVER_STATUSES, default: 'free', index: true },
    pricePerKm: { type: Number, default: 22, min: 0 },
    freeRide: { type: Boolean, default: false },
    heading: { type: Number, default: 0 },
    speedKmh: { type: Number, default: 40 },
    busyUntil: { type: Date },
    rideId: { type: String },
  },
  { timestamps: true, versionKey: false },
);

const rideSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'VDriver', required: true },
    driverName: { type: String, required: true },
    plate: { type: String, required: true },
    carModel: { type: String, required: true },
    pickup: { lat: { type: Number, required: true }, lon: { type: Number, required: true } },
    dest: { lat: { type: Number, required: true }, lon: { type: Number, required: true } },
    distanceKm: { type: Number, required: true },
    etaMin: { type: Number, required: true },
    finishAt: { type: Date, required: true },
    /** Полилиния маршрута от OSRM (decimated) — тем же путём едет водитель и рисуется линия. */
    routePath: { type: [{ lat: Number, lon: Number }], _id: false, default: [] },
    price: { type: Number, required: true, min: 0 },
    status: { type: String, enum: RIDE_STATUSES, default: 'accepted' },
    /** Обстановка на подаче в момент вызова: unknown — снимок пробок не получен. */
    trafficLevel: { type: String, enum: ['free', 'moderate', 'heavy', 'unknown'], default: 'unknown' },
    /** На сколько минут пробки удлинили подачу относительно свободного потока. */
    pickupDelayMin: { type: Number, default: 0, min: 0 },
    /** Выбрана не ближайшая машина, потому что ближайшая стояла в пробке. */
    trafficPreferred: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

export interface DriverView {
  id: string;
  name: string;
  car: { model: string; plate: string };
  rating: number;
  lat: number;
  lon: number;
  status: (typeof DRIVER_STATUSES)[number];
  pricePerKm: number;
  freeRide: boolean;
  speedKmh: number;
  distanceKm?: number;
  regionLabel?: string;
}

export const VDriver = mongoose.model<mongoose.Document & Record<string, unknown>>('VDriver', vdriverSchema);
export const Ride = mongoose.model<mongoose.Document & Record<string, unknown>>('Ride', rideSchema);
