import mongoose from 'mongoose';
import { env } from './env';
import { log } from './log';

export async function connectDb(serviceName: string) {
  mongoose.set('strictQuery', true);
  const url = env('MONGO_URL', 'mongodb://localhost:27017/dtramp');
  await mongoose.connect(url, { serverSelectionTimeoutMS: 5_000 });
  log.info('MongoDB подключена', { service: serviceName, db: mongoose.connection.name });
}

export function routeDbError(name: string) {
  return (error: unknown) => {
    log.error(`${name}: MongoDB недоступна, сервис не стартует`, {
      message: error instanceof Error ? error.message : String(error),
    });
  };
}
