import type { Express } from 'express';
import mongoose from 'mongoose';
import { envInt } from './env';
import { log } from './log';

export function startServer(app: Express, serviceName: string, port = envInt('PORT', 3000)) {
  const server = app.listen(port, () => {
    log.info(`${serviceName} слушает на :${port}`);
  });

  const shutdown = (signal: string) => {
    log.info(`${serviceName}: остановка (${signal})`);
    server.close(() => {
      void mongoose.disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
