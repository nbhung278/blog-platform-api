# Strix — Backend

API server for the Strix blog platform. Powers the public client and the admin panel.

## Stack

- **Bun** runtime + **Hono** HTTP framework
- **PostgreSQL** + **Prisma 7** ORM
- **Redis** — token version cache, view-counter buffer, rate-limit counters
- **S3-compatible storage** (MinIO local, AWS S3 prod) for image uploads with **sharp** for resize/WebP
- **Nginx** (Docker) reverse proxy with gzip — fronts Bun in production
- WebSocket server (Bun native) for realtime notifications and direct messages

## Features

- JWT auth with refresh-token rotation, HttpOnly cookies, CSRF double-submit
- Per-app cookie partitioning (web vs admin) — log into both apps simultaneously
- RBAC: roles → permissions → users
- Rate limiting (login throttle, IP-based per-route limits)
- Posts: draft → pending → published → rejected workflow with version-based optimistic locking
- Categories, tags, search (title / content / tag / author)
- Image upload pipeline: validate magic bytes → sharp resize (max 1200px, EXIF rotate) → WebP convert → S3 upload
- View counter (Redis buffer flushed every 30s to avoid write-amplification)
- Follow / unfollow with email-notification toggle
- Notifications fanned out over WebSocket
- Direct messaging (1:1 conversations) with reactions + edit + delete
- CDN cache: 5 public endpoints cached at Cloudflare edge (see `ROADMAP.md`)

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.2
- Docker (for local Postgres / Redis / MinIO via `docker-compose`)

## Setup

```bash
# Install deps
bun install

# Copy env and fill in secrets
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET (32+ chars)

# Boot local infra (Postgres + Redis + MinIO)
docker-compose up -d

# Run migrations + seed roles/permissions
bun run db:migrate
bun run db:seed

# Start dev server (auto-reloads on file change)
bun run dev
```

Server listens on `http://localhost:3000` by default.

## Common scripts

| Command | What it does |
|---|---|
| `bun run dev` | Start with watch mode |
| `bun run start` | Production start |
| `bun run db:migrate` | Apply Prisma migrations |
| `bun run db:seed` | Seed default roles + permissions |
| `bun run db:studio` | Open Prisma Studio |
| `bun run check` | Type-check + lint + format check |
| `bun run lint:fix` | Auto-fix lint issues |
| `bun run format` | Run Prettier |

## Architecture notes

- **Auth flow**: `/auth/login` issues access (15m) + refresh (30d) + CSRF cookies. The CSRF cookie is JS-readable; clients echo it back via `X-CSRF-Token` for double-submit verification on state-changing requests.
- **Token revocation**: every user has a `tokenVersion`. Bumping it (logout-all, password change) invalidates every issued JWT immediately, even un-expired ones.
- **WebSocket**: `/ws` upgrades verify the access cookie + check `tokenVersion`, enforce origin allowlist, and cap connections per user. Logout / password change actively disconnect open sockets via `disconnectUser()`.
- **CSP**: backend only emits JSON, but a strict CSP is set as defense-in-depth.
- **Cache headers**: public read endpoints emit `Cache-Control: public, s-maxage=...` so Cloudflare can cache at the edge. See `ROADMAP.md` for the cache rule + endpoint TTLs.

## Project layout

```
src/
  index.ts              # entry: Hono app + Bun.serve + WebSocket handler
  db/                   # Prisma client
  middleware/
    auth.ts             # authMiddleware + RBAC helpers + CSRF check
    rate-limit.ts       # IP/login rate limiters (Redis-backed)
  lib/
    cookies.ts          # cookie helpers, app-kind partitioning
    tokens.ts           # JWT issue/rotate/revoke
    notifications.ts    # createNotification + fanoutNotification
    realtime.ts         # in-memory subscriber map + publishToUser
    ws.ts               # WebSocket auth + handlers
    permissions.ts      # PermissionKey constants
    s3.ts               # S3 upload helpers
    view-counter.ts     # Redis buffer + periodic flush to Postgres
  routes/
    auth.ts             # login/register/logout/me/change-password
    posts.ts            # CRUD + feed + search
    follows.ts          # follow/unfollow/email-toggle
    notifications.ts    # list/mark-read/unread-count
    conversations.ts    # direct messages 1:1
    bookmarks.ts claps.ts comments.ts
    categories.ts roles.ts users.ts uploads.ts analytics.ts share.ts
prisma/
  schema.prisma         # source of truth for the DB
  migrations/           # generated migration history
  seed.ts               # roles + permissions seed
nginx/                  # prod reverse proxy config (mounted into nginx container)
```

## Environment variables

See `.env.example`. Notable:

- `JWT_SECRET` — must be 32+ random bytes in production
- `APP_URL` / `ADMIN_URL` — added to CORS allowlist and WebSocket origin allowlist; must match exactly (including protocol)
- `ALLOW_REGISTRATION` — flip to `false` to lock down public sign-up
- `S3_*` — bucket, region, access key, secret, public URL (or CDN)

## Deploying

In production:

- Set `NODE_ENV=production` (cookies become `Secure`)
- Stack uses **Nginx container** as reverse proxy (gzip enabled, Cloudflare Origin Cert) — see `../scripts/DEPLOY.md`
- Cloudflare proxy ON for all subdomains; cache rule in place for public read endpoints
- Use managed Redis (or a single shared instance — token cache, rate limit, view-counter all live there)
- For S3, swap MinIO endpoint/keys to AWS or any S3-compatible provider
- Run `prisma migrate deploy` — never `migrate dev` against prod
- `./scripts/deploy-backend.sh` handles rsync + rebuild + smoke test

## Roadmap

See `ROADMAP.md` for performance/UX improvements (compression, skeleton loaders, CDN cache, etc.) — most done as of 2026-05-08.
