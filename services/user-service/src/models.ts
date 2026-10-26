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
  },
  { timestamps: true, versionKey: false },
);

export const User = mongoose.model<UserAttrs>('User', userSchema);

type UserDoc = UserAttrs & { _id: mongoose.Types.ObjectId };

/** Срез пользователя без хеша пароля — то, что можно отдавать наружу. */
export function toPublic(user: mongoose.HydratedDocument<UserAttrs>): PublicUser {
  const { _id, passwordHash, ...rest } = user.toObject() as Partial<UserDoc> & { _id: mongoose.Types.ObjectId };
  void passwordHash;
  return { ...rest, id: _id.toString() } as PublicUser;
}
