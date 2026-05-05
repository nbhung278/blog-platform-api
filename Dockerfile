FROM oven/bun:1.2-alpine AS base
WORKDIR /app
RUN apk add --no-cache vips

FROM base AS prod-deps
RUN apk add --no-cache vips-dev build-base python3
COPY package.json bun.lock ./
RUN sed -i 's/"prepare": *"husky"/"prepare": ":"/' package.json \
  && bun install --frozen-lockfile --production \
  && rm -rf \
    node_modules/chart.js \
    node_modules/react-dom \
    node_modules/react \
    node_modules/@kurkle \
    node_modules/@radix-ui \
    node_modules/mysql2 \
  && find node_modules -name '*.map' -delete \
  && find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} + \
  && find node_modules -name 'CHANGELOG*' -delete \
  && find node_modules -name 'README*' -delete \
  && find node_modules -name '*.md' -delete

FROM base AS build
RUN apk add --no-cache vips-dev build-base python3
COPY package.json bun.lock ./
RUN sed -i 's/"prepare": *"husky"/"prepare": ":"/' package.json \
  && bun install --frozen-lockfile
COPY prisma ./prisma
ENV DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy
RUN bunx prisma generate

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
RUN find node_modules/@prisma/client/runtime \
      \( -name '*cockroachdb*' -o -name '*mysql*' -o -name '*sqlite*' -o -name '*sqlserver*' \) -delete
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app src ./src
COPY --chown=app:app package.json tsconfig.json prisma.config.ts ./

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1
CMD ["bun", "run", "src/index.ts"]
