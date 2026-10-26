import { HttpError } from './errors';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
  timeoutMs?: number;
}

/** JSON-вызов внутреннего сервиса. Ошибки сервиса пробрасываются с его статусом. */
export async function callService<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, timeoutMs = 5_000 } = options;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((cause: Error) => {
    throw new HttpError(502, `${baseUrl}${path} недоступен: ${cause.message}`);
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = (payload as { error?: string } | undefined)?.error ?? `Ответ ${response.status}`;
    throw new HttpError(response.status, message, payload);
  }
  return payload as T;
}
