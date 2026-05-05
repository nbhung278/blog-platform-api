FROM oven/bun:1.2-alpine AS base
WORKDIR /app
# sharp needs libvips at runtime; install once in the base layer so every
# downstream stage has it.
RUN apk add --no-cache vips

FROM base AS deps
# Headers + compiler needed only while sharp links against libvips during install.
RUN apk add --no-cache vips-dev build-base python3
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy
RUN bunx prisma generate
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
