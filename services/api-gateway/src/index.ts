import cors from 'cors';
import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { GraphQLError } from 'graphql';
import { env, envInt, log, startServer, tokenFromHeader, verifyToken } from '@dtramp/shared';
import { typeDefs } from './schema';
import { createContext, resolvers, type Context } from './resolvers';

const app = express();
const server = new ApolloServer<Context>({
  typeDefs,
  resolvers,
  introspection: true,
});

await server.start();

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'api-gateway' });
});

app.use(
  '/graphql',
  cors<cors.CorsRequest>({ origin: true }),
  express.json({ limit: '256kb' }),
  expressMiddleware(server, {
    context: async ({ req }) => {
      const token = tokenFromHeader(req.headers.authorization);
      if (!token) return createContext(undefined, undefined);
      try {
        return createContext(token, verifyToken(token));
      } catch {
        throw new GraphQLError('Токен недействителен или просрочен', { extensions: { code: 'UNAUTHENTICATED' } });
      }
    },
  }),
);

const port = envInt('GATEWAY_PORT', envInt('PORT', 4000));
startServer(app, 'api-gateway', port);
log.info('D-Tramp GraphQL gateway', {
  endpoint: `http://localhost:${port}/graphql`,
  upstreams: {
    user: env('USER_SERVICE_URL', 'http://localhost:4001'),
    trip: env('TRIP_SERVICE_URL', 'http://localhost:4002'),
    map: env('MAP_SERVICE_URL', 'http://localhost:4003'),
  },
});
