import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  HttpError,
  ROLES,
  asyncHandler,
  email as emailField,
  requireAuth,
  signToken,
  str,
  type AuthUser,
} from '@dtramp/shared';
import { User, toPublic, type UserAttrs } from './models';

const router = Router();

function authPayload(user: mongoose.HydratedDocument<UserAttrs>): { token: string; user: ReturnType<typeof toPublic> } {
  const publicUser = toPublic(user);
  const claim: AuthUser = { id: publicUser.id, role: publicUser.role, email: publicUser.email, name: publicUser.name };
  return { token: signToken(claim), user: publicUser };
}

router.post(
  '/register',
  asyncHandler(async (request, response) => {
    const body = request.body as Record<string, unknown>;
    const email = emailField(body);
    const password = str(body, 'password', { min: 6, max: 128 })!;
    const name = str(body, 'name', { min: 2, max: 80 })!;
    const role = str(body, 'role', { optional: true }) ?? 'passenger';
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new HttpError(400, `role должен быть одним из: ${ROLES.join(', ')}`);
    }
    const phone = str(body, 'phone', { optional: true, max: 24 });

    if (await User.exists({ email })) throw new HttpError(409, 'Пользователь с таким email уже зарегистрирован');

    const user = await User.create({ email, passwordHash: await bcrypt.hash(password, 10), name, role, phone });
    response.status(201).json(authPayload(user));
  }),
);

router.post(
  '/login',
  asyncHandler(async (request, response) => {
    const body = request.body as Record<string, unknown>;
    const email = emailField(body);
    const password = str(body, 'password', { min: 1 })!;

    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(401, 'Неверный email или пароль');
    }
    response.json(authPayload(user));
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const user = await User.findById(request.auth!.id);
    if (!user) throw new HttpError(404, 'Пользователь не найден');
    response.json(toPublic(user));
  }),
);

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const body = request.body as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    const name = str(body, 'name', { optional: true, min: 2, max: 80 });
    if (name) update.name = name;
    const phone = str(body, 'phone', { optional: true, max: 24 });
    if (phone !== undefined) update.phone = phone;
    if (body.role !== undefined && body.role !== null && body.role !== '') {
      if (!(ROLES as readonly string[]).includes(String(body.role))) {
        throw new HttpError(400, `role должен быть одним из: ${ROLES.join(', ')}`);
      }
      update.role = String(body.role);
    }
    if (str(body, 'password', { optional: true, min: 6, max: 128 })) {
      update.passwordHash = await bcrypt.hash(String(body.password), 10);
    }
    if (!Object.keys(update).length) throw new HttpError(400, 'Нет полей для обновления');

    const user = await User.findByIdAndUpdate(request.auth!.id, update, { new: true });
    if (!user) throw new HttpError(404, 'Пользователь не найден');
    response.json(toPublic(user));
  }),
);

/** Публичный профиль — нужен trip-service и gateway, чтобы показать водителя поездки. */
router.get(
  '/users/:id',
  asyncHandler(async (request, response) => {
    if (!mongoose.Types.ObjectId.isValid(request.params.id!)) throw new HttpError(400, 'Некорректный id');
    const user = await User.findById(request.params.id);
    if (!user) throw new HttpError(404, 'Пользователь не найден');
    response.json(toPublic(user));
  }),
);

/** Пакетная выдача профилей — чтобы gateway не дёргал /users/:id на каждую поездку. */
router.post(
  '/users/batch',
  asyncHandler(async (request, response) => {
    const ids = (request.body as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) throw new HttpError(400, 'Поле "ids" должно быть массивом');
    const valid = ids.filter((id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id));
    const users = await User.find({ _id: { $in: valid } });
    response.json(users.map(toPublic));
  }),
);

export default router;
