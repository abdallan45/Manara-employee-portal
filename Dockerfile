# Multi-stage build: shared package, API (NestJS + Prisma) and the static web export,
# served by one Node process. Runs fully offline once built.
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @workforce/shared \
 && npx -w @workforce/api prisma generate \
 && npm run build -w @workforce/api \
 && npm run build -w @workforce/web \
 && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache openssl tini && addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WEB_DIST=/app/apps/web/out
COPY --from=build --chown=app:app /app/node_modules node_modules
COPY --from=build --chown=app:app /app/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=app:app /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=app:app /app/apps/api/package.json apps/api/package.json
COPY --from=build --chown=app:app /app/apps/api/dist apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/prisma apps/api/prisma
COPY --from=build --chown=app:app /app/apps/web/out apps/web/out
USER app
WORKDIR /app/apps/api
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# Apply pending migrations as the schema owner (MIGRATE_DATABASE_URL; the prisma CLI reads
# DATABASE_URL), then start the API as the runtime role (DATABASE_URL). Without
# MIGRATE_DATABASE_URL both use DATABASE_URL. The owner URL is removed from the API's environment.
CMD ["sh", "-c", "DATABASE_URL=\"${MIGRATE_DATABASE_URL:-$DATABASE_URL}\" npx prisma migrate deploy && unset MIGRATE_DATABASE_URL && exec node dist/src/main.js"]
