# Фронтенд D-Tramp: Vue собирается Vite'ом, отдаётся nginx'ом.
# nginx заодно проксирует /graphql в api-gateway, чтобы браузер говорил с одним источником.

FROM node:22-alpine AS build
WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY assets ./assets

RUN npm ci --no-audit --no-fund --workspace services/web --include-workspace-root
RUN npm run build --workspace services/web

FROM nginx:1.27-alpine
COPY services/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/services/web/dist /usr/share/nginx/html
EXPOSE 80
