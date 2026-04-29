# Strix — Backend

API server for the Strix blog platform. Powers the public client and the admin panel.

## Stack

- **Bun** runtime + **Hono** HTTP framework
- **PostgreSQL** with **pgvector** (embeddings for RAG chat)
- **Redis** — token version cache, view-counter buffer, BullMQ job queue
- **Prisma 7** ORM
- **MinIO / S3** for image uploads
- **Anthropic / OpenAI** SDK for AI chat
- WebSocket server (Bun native) for realtime notifications

## Features

- JWT auth with refresh-token rotation, HttpOnly cookies, CSRF double-submit
- Per-app cookie partitioning (web vs admin) — log into both apps simultaneously
- RBAC: roles → permissions → users
- Rate limiting (login throttle, IP-based per-route limits)
- Posts: draft → pending → published → rejected workflow with version-based optimistic locking
- Categories, tags, search (title / content / tag / author)
- AI chat over post embeddings (RAG with pgvector)
- View counter (Redis buffer flushed every 30s to avoid write-amplification)
- Follow / unfollow with email-notification toggle
- Notifications (follow + post publish + post update) fanned out over WebSocket

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0
- Docker (for local Postgres/Redis/MinIO via `docker-compose`)
- An Anthropic or OpenAI API key

## Setup

```bash
# Install deps
bun install

# Copy env and fill in secrets
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET, ANTHROPIC_API_KEY (or OPENAI_API_KEY)

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
  routes/
    auth.ts             # login/register/logout/me/change-password
    posts.ts            # CRUD + feed + search
    follows.ts          # follow/unfollow/email-toggle
    notifications.ts    # list/mark-read/unread-count
    categories.ts roles.ts users.ts uploads.ts ai.ts analytics.ts
prisma/
  schema.prisma         # source of truth for the DB
  migrations/           # generated migration history
  seed.ts               # roles + permissions seed
```

## Environment variables

See `.env.example`. Notable:

- `JWT_SECRET` — must be 32+ random bytes in production
- `APP_URL` / `ADMIN_URL` — added to CORS allowlist and WebSocket origin allowlist; must match exactly (including protocol)
- `ALLOW_REGISTRATION` — flip to `false` to lock down public sign-up
- `LLM_PROVIDER` — `anthropic` or `openai`

## Deploying

In production:

- Set `NODE_ENV=production` (cookies become `Secure`)
- Use a reverse proxy (Nginx/Cloudflare) — terminate TLS there, forward `Host` and `X-Forwarded-For`
- Provision Postgres with the `pgvector` extension enabled
- Use managed Redis (or a single shared instance — token cache, queue, view-counter all live there)
- For S3, swap MinIO endpoint/keys to AWS or any S3-compatible provider
- Run `prisma migrate deploy` — never `migrate dev` against prod
