import mongoose from 'mongoose';
import type { GeoPoint } from '@dtramp/shared';

export const TRIP_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export const BOOKING_STATUSES = ['confirmed', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

const pointSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lon: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
);

const tripSchema = new mongoose.Schema(
  {
    driverId: { type: String, required: true, index: true },
    from: { type: pointSchema, required: true },
    to: { type: pointSchema, required: true },
    dateTime: { type: Date, required: true, index: true },
    seatsTotal: { type: Number, required: true, min: 1, max: 8 },
    seatsAvailable: { type: Number, required: true, min: 0 },
    price: { type: Number, required: true, min: 0 },
    distanceKm: { type: Number, min: 0 },
    status: { type: String, enum: TRIP_STATUSES, default: 'scheduled', index: true },
    comment: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true, versionKey: false },
);

const bookingSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    userId: { type: String, required: true, index: true },
    seats: { type: Number, required: true, min: 1 },
    status: { type: String, enum: BOOKING_STATUSES, default: 'confirmed' },
    priceTotal: { type: Number, required: true, min: 0 },
  },
  { timestamps: true, versionKey: false },
);

/** Место не может быть забронировано дважды в одной поездке. */
bookingSchema.index({ tripId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: 'confirmed' } });

export interface TripDoc extends mongoose.Document {
  driverId: string;
  from: GeoPoint;
  to: GeoPoint;
  dateTime: Date;
  seatsTotal: number;
  seatsAvailable: number;
  price: number;
  distanceKm?: number;
  status: TripStatus;
  comment?: string;
  createdAt: Date;
}

export interface BookingDoc extends mongoose.Document {
  tripId: mongoose.Types.ObjectId;
  userId: string;
  seats: number;
  status: BookingStatus;
  priceTotal: number;
  createdAt: Date;
}

export const Trip = mongoose.model<TripDoc>('Trip', tripSchema);
export const Booking = mongoose.model<BookingDoc>('Booking', bookingSchema);
