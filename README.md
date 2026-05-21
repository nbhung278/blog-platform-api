# Strix — Backend

API server cho Strix blog platform. Powers public client + admin panel.

**Stack**: Bun + Hono + Prisma 7 + Postgres + Redis + S3-compatible storage + Nginx + WebSocket.

> Đọc [../CLAUDE.md](../CLAUDE.md) ở root project để nắm overview kiến trúc, cookie protocol, deploy workflow.

## Quick start

```bash
# Prerequisites: Bun ≥ 1.2, Docker

# Boot local infra (Postgres + Redis + Minio)
docker compose up -d

# Setup
bun install
cp .env.example .env  # fill JWT_SECRET (32+ chars), S3 keys (minioadmin local)
bun run db:migrate
bun run db:seed

# Dev (auto-reload)
bun run dev  # :3000
```

## Scripts

| Command | What |
| --- | --- |
| `bun run dev` | Watch mode |
| `bun run check` | tsc + eslint + prettier check |
| `bun run lint:fix` | Auto-fix lint |
| `bun run db:migrate` | Apply Prisma migrations |
| `bun run db:seed` | Seed roles + permissions |
| `bun run db:studio` | Open Prisma Studio |

## Project layout

```
src/
  index.ts              # Hono app + Bun.serve + WebSocket handler
  db/index.ts           # Prisma client
  middleware/
    auth.ts             # authMiddleware + RBAC + CSRF check
    rate-limit.ts       # IP/login limiters (Redis-backed)
    idempotency.ts      # Idempotency-Key support
  lib/
    cookies.ts          # ⚠ KEEP IN SYNC với 2 SPA's authConstants.ts
    tokens.ts           # JWT issue/rotate/revoke + tokenVersion
    permissions.ts      # 17 PermissionKey constants
    request-context.ts  # extract (ip, userAgent)
    prisma-errors.ts    # isUniqueViolation helper
    ssrf-guard.ts       # DNS resolve + IP block + pinned IP
    s3.ts otp.ts ws.ts realtime.ts view-counter.ts cron.ts
  routes/
    auth.ts             # login/register/logout/me/refresh/google
    posts.ts            # CRUD + feed + search + by-categories
    follows.ts notifications.ts conversations.ts
    bookmarks.ts claps.ts comments.ts
    categories.ts roles.ts users.ts uploads.ts analytics.ts
    share.ts            # /share/* — OG tags cho social crawler
    sitemap.ts feed.ts webhooks.ts contact.ts
prisma/
  schema.prisma         # DB source of truth
  migrations/
  seed.ts
nginx/                  # prod reverse proxy config (mount vào nginx container)
scripts/
  setup-ec2.sh          # Lightsail bootstrap (1 lần)
  backup-db.sh          # daily backup → S3 (chạy qua systemd timer)
```

## Production deploy

Xem [../scripts/DEPLOY.md](../scripts/DEPLOY.md) cho kiến trúc + setup lần đầu.

```bash
./scripts/deploy-backend.sh             # rsync + rebuild + smoke test
./scripts/deploy-backend.sh --migrate   # kèm prisma migrate deploy
```

**Critical env trên prod**: `NODE_ENV=production`, `TRUST_PROXY=true`, `SETUP_TOKEN` (32+ hex chars). Backend Zod refine sẽ fail boot nếu thiếu `SETUP_TOKEN` trong prod.

Khi thêm env mới: phải sync **3 chỗ**:
1. `.env.production.example` (template)
2. `src/lib/env.ts` (Zod schema — dùng `optionalEnvString` helper cho optional, không bare `.optional()`)
3. `docker-compose.prod.yml` `environment:` block (container chỉ thấy env được whitelist ở đây)

## Roadmap

[ROADMAP.md](ROADMAP.md) — performance/UX improvements (đa số đã ship as of 2026-05-08).
