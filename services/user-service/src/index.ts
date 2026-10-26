import express from 'express';
import mongoose from 'mongoose';
import { connectDb, errorHandler, notFound, startServer } from '@dtramp/shared';
import routes from './routes';

const app = express();
app.use(express.json({ limit: '128kb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'user-service', mongo: mongoose.connection.readyState === 1 ? 'up' : 'down' });
});

app.use(routes);
app.use(notFound);
app.use(errorHandler);

await connectDb('user-service');
startServer(app, 'user-service');
