FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
# Smoke-тест запускается внутри контейнера api-gateway в CI.
COPY scripts/smoke.mjs ./scripts/smoke.mjs

# NODE_ENV=production => devDependencies (typescript, @types) в образ не попадают,
# tsx остался в dependencies, потому что рантайм сервисов — TypeScript напрямую.
RUN npm ci --no-audit --no-fund

# SERVICE_NAME выбирает, какой сервис workspace запускать.
ARG SERVICE_NAME=api-gateway
ENV SERVICE_NAME=${SERVICE_NAME}

EXPOSE 3000
CMD ["sh", "-c", "npm run start -w services/${SERVICE_NAME}"]
