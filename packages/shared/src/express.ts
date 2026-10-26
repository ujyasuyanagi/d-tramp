import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors';
import { tokenFromHeader, verifyToken, type AuthUser } from './jwt';
import { log } from './log';

declare module 'express' {
  interface Request {
    auth?: AuthUser;
  }
}

function readAuth(request: Request): AuthUser | undefined {
  const token = tokenFromHeader(request.headers.authorization);
  if (!token) return undefined;
  return verifyToken(token);
}

/** Ставит req.auth, если токен валидный; без токена пропускает дальше. */
export function optionalAuth(request: Request, _response: Response, next: NextFunction) {
  request.auth = readAuth(request);
  next();
}

export function requireAuth(request: Request, _response: Response, next: NextFunction) {
  request.auth = readAuth(request);
  if (!request.auth) {
    next(new HttpError(401, 'Требуется авторизация'));
    return;
  }
  next();
}

export function asyncHandler<T extends (request: Request, response: Response) => Promise<unknown>>(handler: T) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

export function notFound(_request: Request, response: Response) {
  response.status(404).json({ error: 'Не найдено' });
}

export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error('Необработанная ошибка', { message });
  response.status(500).json({ error: 'Внутренняя ошибка сервиса' });
}
