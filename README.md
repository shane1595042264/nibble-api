# nibble-api

Backend API for WordByWord — a local-first AI-powered PDF reading tracker for technical books.

**Stack:** Hono + TypeScript + Drizzle ORM + PostgreSQL + Cloudflare R2 + Stripe + Claude API + Mathpix

## Local Setup

### Prerequisites

- Node.js 22+
- Docker (for PostgreSQL)

### 1. Start PostgreSQL

```bash
docker run --name nibble-pg \
  -e POSTGRES_DB=nibble \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  -d postgres:16
```

If the container already exists but is stopped:

```bash
docker start nibble-pg
```

### 2. Enable pg_trgm extension (fuzzy search)

```bash
docker exec nibble-pg psql -U postgres -d nibble -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

### 3. Install dependencies

```bash
npm install
```

### 4. Configure environment

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

Required for local dev:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/nibble` | Local Docker PG |
| `JWT_SECRET` | Must match `AUTH_SECRET` in frontend's `.env.local` | e.g. `k8UqB++7/nbkD5jxmpXiTeLItfsdn10EL96KUGFYOaQ=` |
| `PORT` | `4000` | |
| `CORS_ORIGIN` | `http://localhost:3000` | Frontend URL |

Optional (features degrade gracefully without these):

| Variable | Notes |
|----------|-------|
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2 — needed for PDF cloud storage |
| `ANTHROPIC_API_KEY` | Needed for AI processing pipeline and AI proxy routes |
| `MATHPIX_APP_ID`, `MATHPIX_APP_KEY` | Needed for math/LaTeX extraction |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Needed for billing — skip for local dev |

### 5. Run database migrations

```bash
npm run db:migrate
```

### 6. Start the dev server

```bash
npm run dev
```

Server runs on `http://localhost:4000`. Test with:

```bash
curl http://localhost:4000/api/health
# {"status":"ok","timestamp":"..."}
```

## Connecting to the DB (WebStorm / DataGrip)

| Field | Value |
|-------|-------|
| Host | `localhost` |
| Port | `5432` |
| User | `postgres` |
| Password | `postgres` |
| Database | `nibble` |
| URL | `jdbc:postgresql://localhost:5432/nibble` |

You can also browse the DB with Drizzle Studio:

```bash
npm run db:studio
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled JS (production) |
| `npm test` | Run tests (watch mode) |
| `npm run test:run` | Run tests once |
| `npm run db:generate` | Generate migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Open Drizzle Studio (DB browser) |

## API Overview

All routes except `/api/health` and `/api/billing/webhook` require `Authorization: Bearer <token>`.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/health` | No | Health check |
| POST | `/api/sync` | Yes | Bidirectional sync |
| GET/POST/PUT/DELETE | `/api/books/*` | Yes | Book CRUD + match + upload |
| GET/POST/PUT/DELETE | `/api/chapters/*` | Yes | Chapter CRUD |
| GET/POST/PUT/DELETE | `/api/sections/*` | Yes | Section CRUD |
| GET/POST/PUT/DELETE | `/api/vocabulary/*` | Yes | Vocabulary CRUD |
| GET/PUT | `/api/settings` | Yes | User settings |
| POST | `/api/ai/word-context` | Yes | AI word lookup |
| POST | `/api/ai/translate` | Yes | AI translation |
| POST | `/api/ai/explain` | Yes | AI explanation |
| POST | `/api/processing/start` | Yes | Start AI processing |
| GET | `/api/processing/:jobId` | Yes | Processing status |
| POST | `/api/billing/create-payment` | Yes | Stripe payment |
| POST | `/api/billing/webhook` | No* | Stripe webhook (*signature verified) |
| GET | `/api/billing/history` | Yes | Payment history |
| GET/PUT/DELETE | `/api/admin/catalog/*` | Admin | Catalog management |
| GET | `/api/admin/jobs` | Admin | Processing jobs |
| GET | `/api/admin/stats` | Admin | Usage metrics |

## Architecture

```
Frontend (Next.js)          Backend (Hono)
    |                           |
    |-- IndexedDB (local) --+   |-- PostgreSQL (13 tables)
    |                       |   |-- Cloudflare R2 (PDFs, .nib files)
    |-- /api/auth/token ----|-->|-- JWT verification
    |                       |   |-- Background job worker
    |-- Sync every 30s -----|-->|-- POST /api/sync
    |                           |
    Local-first reading         Cloud sync + AI processing + billing
```
