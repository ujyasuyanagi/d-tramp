import jwt from 'jsonwebtoken';
import { env } from './env';
import { HttpError } from './errors';

const secret = () => env('JWT_SECRET', 'dev-secret-change-me');
const TTL = '7d';

export interface AuthUser {
  id: string;
  role: 'driver' | 'passenger';
  email: string;
  name: string;
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, secret(), { expiresIn: TTL });
}

export function verifyToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, secret());
    if (typeof payload === 'string') throw new Error('bad payload');
    const { id, role, email, name } = payload as jwt.JwtPayload & AuthUser;
    return { id, role, email, name };
  } catch {
    throw new HttpError(401, 'Недействительный или просроченный токен');
  }
}

export function tokenFromHeader(header?: string): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? value : undefined;
}
