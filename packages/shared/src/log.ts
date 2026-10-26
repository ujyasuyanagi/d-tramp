const SERVICE = process.env.SERVICE_NAME ?? 'app';

function emit(level: string, message: string, extra?: unknown) {
  const line = { ts: new Date().toISOString(), level, service: SERVICE, message, ...(extra ? { extra } : {}) };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else console.log(text);
}

export const log = {
  info: (message: string, extra?: unknown) => emit('info', message, extra),
  warn: (message: string, extra?: unknown) => emit('warn', message, extra),
  error: (message: string, extra?: unknown) => emit('error', message, extra),
};
