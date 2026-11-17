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

- **How a new word gets there (since 2026-11-17, an outbox):** `src/services/sync.service.ts` saves the new word into `vocabulary` with `kb_forwarded_at` NULL (= owed to the KB) and wakes `src/jobs/kb-forward.ts`. That job claims owed words (lease + `FOR UPDATE SKIP LOCKED`), forwards each with a 90s timeout, marks it `kb_forwarded_at = now()`, or records the error and retries with backoff (30s doubling, capped at 6h, forever). Keep that timeout above the KB's worst case: the KB does not dedup, so a forward we abandon still creates its card and the retry creates a second. It also sweeps every minute and on startup. A slow or down KB no longer fails anything in `POST /api/sync`; `failedEntities.vocabulary` now only means a database error on the word. Before this, the forward ran inline BEFORE the insert with a 10s timeout, and a slow KB showed "Sync failed" on the client (northstar Section 0, 2026-11-17).
- **The outbox columns (`kb_forwarded_at`, `kb_forward_attempts`, `kb_next_attempt_at`, `kb_last_error`) are server-only.** `sync.service.ts` strips them from rows it sends and rows it receives (`withoutKbOutboxFields`), and they're only written with raw SQL so `updated_at` never moves. Find stuck words with `SELECT id, word, kb_forward_attempts, kb_last_error FROM vocabulary WHERE kb_forwarded_at IS NULL AND deleted_at IS NULL`.
- **The forwarder primitive:** `src/services/knowledge-base.service.ts`. It composes a classifier-friendly text + nibbler-tagged source object and POSTs with a Bearer PAT (`KNOWLEDGE_BASE_PAT` env var). A 2xx with no entries counts as delivered (KAN-230), but the KB's single-note path always creates a card, so don't rely on it to dedup a re-send.
- **`POST /api/vocabulary`** still exists and still writes to the local PG table — but the WordByWord click flow never calls it. It's effectively dead code. Rows it creates are owed to the KB like any other, so the outbox forwards them too.

**Every new vocab must reach the knowledge base.** Don't add a vocab insert that sets `kb_forwarded_at` itself, don't move the forward back inline into `POST /api/sync`, and don't remove `startKnowledgeBaseForwarder()` from `src/index.ts`.

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

`POST /api/sync` accepts a `{ lastSyncedAt, changes: { books, chapters, sections, vocabulary, settings, exerciseProgress } }` payload and returns `{ serverChanges, failedEntities, syncedAt, pullCursor }`. Chapters and sections are paged by id (MAX_LIST_ROWS per page): a non-null `pullCursor` means more rows remain, and the client re-posts with the same `lastSyncedAt`, empty `changes` and that `pullCursor` until it comes back null, keeping the FIRST page's `syncedAt` as its watermark (KAN-397). The WordByWord frontend uses `failedEntities.*` to know which entities to retry. If you ever introduce a hard failure for a single entity, push its id to the right `failedEntities` array rather than throwing — otherwise the client's dirty-flag bookkeeping gets stuck.

The vocab path inside `sync.service.ts` is the one most likely to surprise you: a new word is saved and then forwarded to the personal-website knowledge base by a background job (`src/jobs/kb-forward.ts`), not inside the request. Read Section 0 of `northstar.md` (2026-11-17 and 2026-05-16) for the why.
