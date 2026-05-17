# CLAUDE.md — nibble-api (Nibbler backend)

You are working on the Hono-on-Bun backend for **Nibbler** — a local-first, AI-powered PDF reading tracker. The frontend is at https://nibbook.com (the `WordByWord` repo, sibling to this one). This backend is at https://nibble-api-production.up.railway.app.

## First, read northstar.md

`northstar.md` is the canonical implementation reference. **Section 0 ("Current State & Evolutions") at the top supersedes anything older in the doc** — pay attention to that section especially. The rest of the file is the original 2026-03-10 build-out plan; treat it as historical context, not current truth.

The frontend (`../WordByWord`) has its own `NorthStar.md` and `CLAUDE.md` — read those when your change crosses the API boundary.

## When intent changes, update northstar.md

This is the rule that prevents agent regressions:

- If the user changes a design decision, **add a dated bullet to Section 0 in `northstar.md`** describing what changed and why. Do NOT delete the older guidance — just note it's superseded.
- If the change is just an implementation detail (refactor, new column, bugfix), don't bother. Commit message + tests are enough.

## Critical contracts (don't break without explicit consent)

### Vocab forwards to shanejli's knowledge base — that's the source of truth

Vocab is no longer stored in this app's `vocabulary` PG table as the authoritative copy. It forwards to https://shanebackend-production.up.railway.app/api/knowledge/notes.

- **Where the forward fires:** `src/services/sync.service.ts`, inside the `if (!server)` branch of the vocabulary loop (the "new vocab" case). It runs BEFORE the local insert. On forward failure → push to `failedEntities.vocabulary` so the WordByWord sync layer re-bumps `updatedAt` and retries on the next sync.
- **The forwarder primitive:** `src/services/knowledge-base.service.ts`. It composes a classifier-friendly text + nibbler-tagged source object and POSTs with a Bearer PAT (`KNOWLEDGE_BASE_PAT` env var).
- **`POST /api/vocabulary`** still exists and still writes to the local PG table — but the WordByWord click flow never calls it. It's effectively dead code. Don't rely on its behavior; if you change it, also change the sync path.

**Don't remove the forward call from `sync.service.ts`.** Every new vocab must reach the knowledge base.

### Env vars that must exist on Railway

- `KNOWLEDGE_BASE_PAT` — PAT minted from the personal-website's `/settings/tokens` UI with `knowledge:write` scope. Without it every new vocab forward 503s.
- `KNOWLEDGE_BASE_URL` — defaults to prod; override for local dev.

## Tech stack

| Layer | Tech |
| --- | --- |
| Runtime | Bun + Hono |
| Language | TypeScript |
| DB | PostgreSQL + Drizzle ORM |
| Storage | Cloudflare R2 (PDF blobs) |
| Auth | JWT (signed with `JWT_SECRET`, minted by WordByWord's `/api/auth/token`) |
| AI | Anthropic SDK (Claude) + Mathpix |
| Hosting | Railway (project: `nibble-backend`, service: `nibble-api`, prod env id: `05b9dc29-...`) |
| Tests | Vitest (`tests/unit/`, `tests/integration/`) |

## Workflow

- Deploy: push to `main`. Railway auto-deploys.
- Tests: `npm test` (vitest). Build: `npm run build` (tsc).
- Type-check before pushing: `npx tsc --noEmit`.

## Auth contract

Every authenticated route uses the auth middleware in `src/middleware/auth.ts`. It verifies the `Authorization: Bearer <jwt>` header, upserts the user via `auth.service.ts`, and sets `c.set('user', user)`. Routes read user as `c.get('user')` — type is `{ id, email, name, authRole }`. There is NO PAT-based auth in this app (only JWT). PAT auth exists in the personal-website backend, not here.

## Sync protocol (where to be careful)

`POST /api/sync` accepts a `{ lastSyncedAt, changes: { books, chapters, sections, vocabulary, settings, exerciseProgress } }` payload and returns `{ serverChanges, failedEntities, syncedAt }`. The WordByWord frontend uses `failedEntities.*` to know which entities to retry. If you ever introduce a hard failure for a single entity, push its id to the right `failedEntities` array rather than throwing — otherwise the client's dirty-flag bookkeeping gets stuck.

The vocab path inside `sync.service.ts` is the one most likely to surprise you: it forwards to the personal-website BEFORE inserting locally, so the local insert is skipped on forward failure. Read Section 0 of `northstar.md` for the why.
