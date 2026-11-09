import mongoose from 'mongoose';
import { ROLES, type Role } from '@dtramp/shared';

export interface UserAttrs {
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
  phone?: string;
  rating: number;
  tripsCount: number;
  /** Внутренний кошелёк: цена списывается при вызове, пополнение — имитация. */
  balance: number;
  ridePayments: { rideId: string; amount: number; refunded: boolean }[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  phone?: string;
  rating: number;
  tripsCount: number;
  balance: number;
  createdAt?: Date;
}

const userSchema = new mongoose.Schema<UserAttrs>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, enum: ROLES },
    phone: { type: String, trim: true },
    rating: { type: Number, default: 5, min: 0, max: 5 },
    tripsCount: { type: Number, default: 0 },
    balance: { type: Number, default: 500 },
    // Баланс и отметка платежа меняются одним атомарным обновлением пользователя.
    ridePayments: {
      type: [{ _id: false, rideId: { type: String, required: true }, amount: { type: Number, required: true }, refunded: { type: Boolean, required: true } }],
      default: [],
      select: false,
    },
  },
  { timestamps: true, versionKey: false },
);

export const User = mongoose.model<UserAttrs>('User', userSchema);

type UserDoc = UserAttrs & { _id: mongoose.Types.ObjectId };

/** Срез пользователя без хеша пароля — то, что можно отдавать наружу. */
export function toPublic(user: mongoose.HydratedDocument<UserAttrs>): PublicUser {
  const { _id, passwordHash, ridePayments, ...rest } = user.toObject() as Partial<UserDoc> & { _id: mongoose.Types.ObjectId };
  void passwordHash;
  void ridePayments;
  return { ...rest, id: _id.toString() } as PublicUser;
}
