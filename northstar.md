# nibble-api — Implementation Plan (Northstar)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## 0. Current State & Evolutions (READ THIS BEFORE ANYTHING ELSE)

The plan below was written 2026-03-10 as the initial build-out. Most of it shipped. This section overrides anything below it when they conflict. Add a dated bullet here whenever the user's intent changes — do NOT silently delete the older sections; just note they're superseded.

### 2026-06-10 — Legacy AI proxy routes removed (KAN-210)

The three original AI proxy routes — `POST /api/ai/word-context`, `POST /api/ai/translate`, `POST /api/ai/explain` — have been deleted from `src/routes/ai.ts` along with their service methods (`wordContext`, `translate`, `explain`) in `src/services/ai.service.ts`. They had no callers in either repo, lacked the `c.req.raw.signal` + `isClientAbort()` handling every sibling route now has, and represented an authenticated cost-burn surface with no abort path.

The reader-side endpoints that superseded them are still live: `/ai/translate-word`, `/ai/translate-sentence`, `/ai/explain-translation`, `/ai/explain-content` (registered in `src/routes/ai.ts`, with matching service methods).

The historical references to the deleted routes at line 58 (File Map), line 2130 (build commit message in the original plan), and lines 2253-2255 (original API table) are left in place as historical context per this section's rule.

### 2026-06-27 — KB dedup is success, not failure (KAN-230)

`forwardVocabToKnowledgeBase` used to throw `KNOWLEDGE_BASE_EMPTY_RESPONSE` when the knowledge base returned a 2xx with an empty `entries[]` array. But that response means the KB **deduped** a word it already has — which is the desired end state for a forward whose whole job is "ensure the word reaches the KB". Throwing pushed the word onto `failedEntities.vocabulary`, so the WordByWord client bumped `updatedAt` and re-forwarded the *same* word on every sync forever — the "sync partial — N items will retry" loop the user reported (461 historical words, all already in the KB after the 2026-05-16 cutover wiped the local PG copy, deduped on every sync).

Now a 2xx with empty entries returns a best-effort entry synthesized from the input instead of throwing, so the caller proceeds to the local PG insert, `serverVocabMap` populates next sync, and the word stops re-forwarding. Only **non-2xx** responses count as forward failures. Don't restore the empty-entries throw.

### 2026-05-16 — Vocab is no longer stored locally; forwarded to shanejli's knowledge base

The nibble-api `vocabulary` table is no longer the source of truth for vocab. The personal-website knowledge base at https://shanebackend-production.up.railway.app/api/knowledge/notes is.

- New service: `src/services/knowledge-base.service.ts` — composes a classifier-friendly text + nibbler-tagged source object and POSTs with a Bearer PAT.
- The forward fires from `sync.service.ts` inside the `if (!server)` branch for vocabulary (the "new vocab" case), BEFORE the local insert. On failure → `failedEntities.vocabulary` so the WordByWord sync layer retries.
- `POST /api/vocabulary` route still exists and still inserts to the local PG table — but the WordByWord frontend never calls it directly anymore. The click flow goes through `POST /api/sync`. The route is effectively dead code, kept for backward compatibility.
- New env vars: `KNOWLEDGE_BASE_URL` (defaults to prod), `KNOWLEDGE_BASE_PAT`. PAT must be set on Railway or every new vocab forward will 503.
- The PAT is named "nibble-api forwarder" with `knowledge:write` scope only, visible/revocable at https://shanejli.com/settings/tokens.
- Sections below that describe `vocabularyRepository.create` as the canonical write path for vocab are historical. Read them for context, but the current write path goes through `forwardVocabToKnowledgeBase` first.

**Why the change:** Shane is consolidating his knowledge surfaces. He wants one knowledge base across all his tools; the personal-website's knowledge module is the canonical store. Nibbler-side flashcards duplicated work.

**Don't undo this without explicit user consent:**
- Don't remove the forward call from `sync.service.ts`. Every new vocab MUST reach the knowledge base.
- Don't re-enable a code path that writes vocab locally without also forwarding. If you add a new vocab write path, it goes through `forwardVocabToKnowledgeBase` too.
- Don't change the response shape of `POST /api/sync` for vocabulary in ways that break the WordByWord dirty-flag/retry machinery. `failedEntities.vocabulary` is the retry signal.

---

**Goal:** Build the backend API for WordByWord — a local-first AI-powered PDF reading tracker for technical books. The core product is converting plain PDFs into modularized, structured, atomic `.nib` format using Claude AI + Mathpix (LaTeX/math).

**Architecture:** Hybrid local-first. The frontend (Next.js) handles PDF rendering, .nib interactions, and offline reading. The backend handles auth, cloud sync, AI proxying, PDF processing, and billing. Each user gets their own isolated cloud space.

**Tech Stack:** Hono + TypeScript + Drizzle ORM + PostgreSQL + Cloudflare R2 + Stripe + Claude API + Mathpix API. Hosted on Railway.

**Design Spec:** See `docs/superpowers/specs/2026-03-10-nibble-api-backend-design.md` for the full approved design with database schema, auth flow, sync protocol, processing pipeline, and billing model.

---

## File Map

Every file that will be created, and what it does:

```
nibble-api/
├── src/
│   ├── index.ts                      # Hono app entry, mount all routes, start server + worker
│   │
│   ├── routes/
│   │   ├── health.ts                 # GET /api/health
│   │   ├── books.ts                  # CRUD /api/books + /api/books/match + /api/books/upload
│   │   ├── chapters.ts              # CRUD /api/chapters
│   │   ├── sections.ts             # CRUD /api/sections
│   │   ├── vocabulary.ts           # CRUD /api/vocabulary
│   │   ├── settings.ts             # GET/PUT /api/settings
│   │   ├── sync.ts                 # POST /api/sync
│   │   ├── ai.ts                   # POST /api/ai/word-context, /translate, /explain
│   │   ├── processing.ts          # POST /api/processing/start, GET /api/processing/:jobId
│   │   ├── billing.ts             # POST /api/billing/create-payment, /webhook, GET /history
│   │   └── admin.ts               # Admin-only: /api/admin/catalog/*, /jobs, /stats
│   │
│   ├── middleware/
│   │   ├── auth.ts                 # JWT verification -> c.set('user', user)
│   │   ├── admin.ts                # Checks c.get('user').auth_role === 'admin'
│   │   ├── cors.ts                 # CORS with CORS_ORIGIN env
│   │   ├── rate-limit.ts          # In-memory rate limiter (per user IP/ID)
│   │   └── error-handler.ts       # Catches errors -> { error: { code, message, status } }
│   │
│   ├── services/
│   │   ├── auth.service.ts         # upsertUser(email, name, googleId?), findByEmail
│   │   ├── book.service.ts         # createBook, matchBook (hash + fuzzy), linkCatalog
│   │   ├── sync.service.ts         # resolveConflicts(clientChanges, serverState) -> mergedResult
│   │   ├── processing.service.ts  # orchestratePipeline(fileHash) — runs steps 1-5
│   │   ├── mathpix.service.ts     # extractMath(pdfPages) -> LaTeX per page
│   │   ├── ai.service.ts          # extractStructure(text+math), identifyExercises, wordContext, translate, explain
│   │   ├── storage.service.ts     # uploadToR2, downloadFromR2, getSignedUrl
│   │   ├── billing.service.ts     # createPaymentIntent, handleWebhook, refund
│   │   └── metadata.service.ts    # lookupGoogleBooks(title, author) -> metadata
│   │
│   ├── repositories/
│   │   ├── user.repository.ts      # users table queries
│   │   ├── book.repository.ts      # books + book_catalog queries
│   │   ├── chapter.repository.ts   # chapters queries
│   │   ├── section.repository.ts   # sections queries
│   │   ├── vocabulary.repository.ts # vocabulary queries
│   │   ├── settings.repository.ts  # user_settings queries
│   │   ├── exercise.repository.ts  # exercises + exercise_progress queries
│   │   └── billing.repository.ts   # processing_jobs + processing_charges queries
│   │
│   ├── db/
│   │   ├── schema.ts               # All Drizzle table definitions (13 tables)
│   │   ├── index.ts                # drizzle(postgres(DATABASE_URL)) connection
│   │   └── migrations/             # Auto-generated by drizzle-kit
│   │
│   ├── jobs/
│   │   ├── queue.ts                # pollForJobs(), markProcessing(), markComplete/Failed()
│   │   └── process-pdf.ts          # The main worker: calls processing.service pipeline
│   │
│   └── lib/
│       ├── config.ts               # Zod schema for env vars, validated on startup
│       ├── jwt.ts                  # verifyJwt(token) -> { sub, email, name, role }
│       ├── hash.ts                 # sha256(buffer) -> hex string
│       └── errors.ts              # AppError class with code, message, status
│
├── tests/
│   ├── unit/
│   │   ├── services/               # Service tests with mocked repos
│   │   │   ├── auth.service.test.ts
│   │   │   ├── sync.service.test.ts
│   │   │   └── billing.service.test.ts
│   │   └── lib/
│   │       ├── jwt.test.ts
│   │       ├── hash.test.ts
│   │       └── config.test.ts
│   ├── integration/
│   │   ├── routes/                 # Full HTTP tests against real DB
│   │   │   ├── health.test.ts
│   │   │   ├── auth.test.ts
│   │   │   └── books.test.ts
│   │   └── helpers/
│   │       └── setup.ts            # Test DB setup/teardown, test user factory
│   └── fixtures/
│       └── sample.pdf              # Small test PDF
│
├── drizzle.config.ts               # Drizzle Kit config (schema path, DB URL, migrations dir)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile                      # Multi-stage: build TS -> run JS
├── .env                            # Local dev env vars (already exists)
├── .env.example                    # Template without secrets
├── .gitignore
└── northstar.md                    # This file
```

---

## Conventions

**Every file follows these patterns:**

1. **Repositories** return raw data. No business logic. One repo per table (or table group).
2. **Services** contain business logic. They call repositories, never the DB directly.
3. **Routes** validate input (Zod), call services, return responses. No business logic.
4. **Middleware** runs before routes. Auth attaches user to context. Admin checks role.
5. **Errors** are thrown as `AppError(code, message, status)` and caught by error-handler middleware.
6. **Soft deletes**: All user-owned entities have `deleted_at`. Queries must filter `WHERE deleted_at IS NULL` by default. Sync queries include deleted records.
7. **Timestamps**: All `updated_at` fields auto-update via Drizzle's `.$onUpdate()`.
8. **UUIDs**: All primary keys are UUIDs generated by PostgreSQL (`uuid_generate_v4()`).
> **Auth note:** There is no separate `/api/auth/*` route. Authentication is handled entirely by the auth middleware — the frontend does the OAuth/credentials flow via NextAuth and sends the JWT to the backend. The backend just verifies it.
> **AI usage tracking:** Deferred to a future iteration. For now, rate limiting is sufficient. When needed, add a `ai_usage` table to track per-user API calls.
9. **Testing**: TDD — write failing test first, then implement. Unit tests mock repos. Integration tests use real DB.
10. **Commits**: Small, frequent. One logical change per commit.

---

## Chunk 1: Project Scaffold & Foundation

### Task 1.1: Initialize Node.js project with TypeScript

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize package.json**

```bash
cd nibble-api
npm init -y
```

- [ ] **Step 2: Install core dependencies**

```bash
# Note: `postgres` is the postgres.js driver (https://github.com/porsager/postgres), NOT the `pg` package
npm install hono @hono/node-server drizzle-orm postgres zod dotenv jose stripe @anthropic-ai/sdk @aws-sdk/client-s3 bcryptjs pdfjs-dist
npm install -D typescript @types/node @types/bcryptjs drizzle-kit vitest tsx
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.env
*.db
```

- [ ] **Step 5: Create .env.example**

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/nibble

# JWT (must match AUTH_SECRET in frontend WordByWord)
JWT_SECRET=your-jwt-secret-here

# Server
PORT=4000
CORS_ORIGIN=http://localhost:3000

# Cloudflare R2
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=nibble-pdfs

# Anthropic (structure extraction + AI proxy)
ANTHROPIC_API_KEY=

# Mathpix (LaTeX/formula extraction)
MATHPIX_APP_ID=
MATHPIX_APP_KEY=

# Stripe (processing fee payments)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Pricing
PROCESSING_PRICE_PER_PAGE_CENTS=5

# Limits
MAX_UPLOAD_SIZE_MB=100
```

- [ ] **Step 6: Add scripts to package.json**

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "test:run": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example
git commit -m "feat: initialize project with TypeScript, Hono, Drizzle, and dependencies"
```

---

### Task 1.2: Config validation & error classes

**Files:**
- Create: `src/lib/config.ts`
- Create: `src/lib/errors.ts`
- Create: `tests/unit/lib/config.test.ts`

- [ ] **Step 1: Write config test**

```typescript
// tests/unit/lib/config.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('config', () => {
  it('throws if DATABASE_URL is missing', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => {
      // Re-import to trigger validation
      delete require.cache[require.resolve('../../../src/lib/config')];
      require('../../../src/lib/config');
    }).toThrow();
  });
});
```

Note: Since this is an ESM project, use dynamic `import()` and `vi.resetModules()` instead of `require`. Example:

```typescript
vi.resetModules();
vi.stubEnv('DATABASE_URL', '');
const { config } = await import('../../../src/lib/config.js');
```

- [ ] **Step 2: Implement config.ts**

```typescript
// src/lib/config.ts
import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  R2_ENDPOINT: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().default('nibble-pdfs'),
  ANTHROPIC_API_KEY: z.string().min(1),
  MATHPIX_APP_ID: z.string().default(''),
  MATHPIX_APP_KEY: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  PROCESSING_PRICE_PER_PAGE_CENTS: z.coerce.number().default(5),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(100),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
```

- [ ] **Step 3: Implement errors.ts**

```typescript
// src/lib/errors.ts
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Pre-defined error factories
export const Errors = {
  unauthorized: (msg = 'Invalid or expired token') =>
    new AppError('UNAUTHORIZED', msg, 401),
  forbidden: (msg = 'Insufficient permissions') =>
    new AppError('FORBIDDEN', msg, 403),
  notFound: (resource: string) =>
    new AppError('NOT_FOUND', `${resource} not found`, 404),
  duplicateBook: () =>
    new AppError('DUPLICATE_BOOK', 'Book already in your library', 409),
  paymentRequired: () =>
    new AppError('PAYMENT_REQUIRED', 'Processing job not yet paid', 402),
  processingFailed: (msg: string) =>
    new AppError('PROCESSING_FAILED', msg, 500),
  aiError: (msg: string) =>
    new AppError('AI_ERROR', msg, 502),
  rateLimited: () =>
    new AppError('RATE_LIMITED', 'Too many requests', 429),
};
```

- [ ] **Step 4: Run tests, verify passing**

```bash
npm test -- --run tests/unit/lib/
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts src/lib/errors.ts tests/
git commit -m "feat: add config validation (Zod) and AppError class"
```

---

### Task 1.3: JWT verification helper

**Files:**
- Create: `src/lib/jwt.ts`
- Create: `src/lib/hash.ts`
- Create: `tests/unit/lib/jwt.test.ts`
- Create: `tests/unit/lib/hash.test.ts`

- [ ] **Step 1: Write JWT test**

```typescript
// tests/unit/lib/jwt.test.ts
import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyJwt } from '../../../src/lib/jwt';

const SECRET = 'test-secret-key-at-least-32-chars!!';

describe('verifyJwt', () => {
  it('verifies a valid token and returns claims', async () => {
    const token = await new SignJWT({ email: 'test@example.com', name: 'Test', role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-uuid-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));

    const claims = await verifyJwt(token, SECRET);
    expect(claims.sub).toBe('user-uuid-123');
    expect(claims.email).toBe('test@example.com');
    expect(claims.role).toBe('user');
  });

  it('throws on invalid token', async () => {
    await expect(verifyJwt('garbage', SECRET)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Implement jwt.ts**

```typescript
// src/lib/jwt.ts
import { jwtVerify } from 'jose';

export interface JwtClaims {
  sub: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims> {
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(secret)
  );
  return {
    sub: payload.sub as string,
    email: payload.email as string,
    name: (payload.name as string) ?? '',
    role: (payload.role as 'user' | 'admin') ?? 'user',
  };
}
```

- [ ] **Step 3: Write hash test and implement**

```typescript
// src/lib/hash.ts
import { createHash } from 'node:crypto';

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --run tests/unit/lib/
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/jwt.ts src/lib/hash.ts tests/unit/lib/
git commit -m "feat: add JWT verification and SHA-256 hashing helpers"
```

---

### Task 1.4: Hono app entry point with middleware

**Files:**
- Create: `src/index.ts`
- Create: `src/middleware/error-handler.ts`
- Create: `src/middleware/cors.ts`
- Create: `src/middleware/auth.ts`
- Create: `src/middleware/admin.ts`
- Create: `src/routes/health.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create error handler middleware**

```typescript
// src/middleware/error-handler.ts
import type { ErrorHandler } from 'hono';
import { AppError } from '../lib/errors.js';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, status: err.status } }, err.status as any);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', status: 500 } }, 500);
};
```

- [ ] **Step 2: Create CORS middleware**

```typescript
// src/middleware/cors.ts
import { cors } from 'hono/cors';
import { config } from '../lib/config.js';

export const corsMiddleware = cors({
  origin: config.CORS_ORIGIN,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});
```

- [ ] **Step 3: Create auth middleware**

This is a key piece — it verifies JWTs from the frontend's NextAuth and upserts the user in our DB.

```typescript
// src/middleware/auth.ts
import type { Context, Next } from 'hono';
import { verifyJwt, type JwtClaims } from '../lib/jwt.js';
import { config } from '../lib/config.js';
import { Errors } from '../lib/errors.js';

// Extend Hono's context variables
declare module 'hono' {
  interface ContextVariableMap {
    user: { id: string; email: string; name: string; authRole: string };
    jwtClaims: JwtClaims;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw Errors.unauthorized();
  }

  const token = header.slice(7);
  let claims: JwtClaims;
  try {
    claims = await verifyJwt(token, config.JWT_SECRET);
  } catch {
    throw Errors.unauthorized();
  }

  c.set('jwtClaims', claims);

  // User upsert will be added in Task 3 when we have the DB layer.
  // For now, set a minimal user object from JWT claims.
  c.set('user', {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    authRole: claims.role,
  });

  await next();
}
```

- [ ] **Step 4: Create admin middleware**

```typescript
// src/middleware/admin.ts
import type { Context, Next } from 'hono';
import { Errors } from '../lib/errors.js';

export async function adminMiddleware(c: Context, next: Next) {
  const user = c.get('user');
  if (user.authRole !== 'admin') {
    throw Errors.forbidden('Admin access required');
  }
  await next();
}
```

- [ ] **Step 5: Create health route**

```typescript
// src/routes/health.ts
import { Hono } from 'hono';

export const healthRoutes = new Hono();

healthRoutes.get('/', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});
```

- [ ] **Step 6: Create app entry point**

```typescript
// src/index.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './lib/config.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';

const app = new Hono().basePath('/api');

// Global middleware
app.use('*', corsMiddleware);
app.onError(errorHandler);

// Public routes
app.route('/health', healthRoutes);

// Auth-protected routes will be mounted here in later tasks

serve({ fetch: app.fetch, port: config.PORT }, () => {
  console.log(`nibble-api running on port ${config.PORT}`);
});

export default app;
```

- [ ] **Step 7: Create vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

- [ ] **Step 8: Verify server starts**

```bash
npm run dev
# In another terminal:
curl http://localhost:4000/api/health
# Expected: {"status":"ok","timestamp":"..."}
```

- [ ] **Step 9: Commit**

```bash
git add src/ vitest.config.ts
git commit -m "feat: Hono app with health check, auth/admin/CORS/error middleware"
```

---

## Chunk 2: Database Schema & Drizzle Setup

### Task 2.1: Drizzle configuration and schema

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/db/index.ts`
- Create: `src/db/schema.ts`

- [ ] **Step 1: Create drizzle.config.ts**

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 2: Create DB connection**

```typescript
// src/db/index.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../lib/config.js';
import * as schema from './schema.js';

const client = postgres(config.DATABASE_URL);
export const db = drizzle(client, { schema });
export type Database = typeof db;
```

- [ ] **Step 3: Create full schema — all 13 tables**

This is the biggest single file. It defines every table from the design spec.

```typescript
// src/db/schema.ts
import {
  pgTable, uuid, text, integer, boolean, timestamp,
  real, bigint, jsonb, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ============ USERS ============
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').unique(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  passwordHash: text('password_hash'),
  authRole: text('auth_role').notNull().default('user'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ USER SETTINGS ============
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  autoReadThresholdSeconds: integer('auto_read_threshold_seconds').default(5),
  defaultViewMode: text('default_view_mode').default('pdf'),
  readingMode: text('reading_mode').default('scroll'),
  trackingMode: text('tracking_mode').default('timer'),
  targetLanguage: text('target_language'),
  keymapOverrides: jsonb('keymap_overrides').default({}),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ BOOK CATALOG (shared, admin-only) ============
export const bookCatalog = pgTable('book_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  author: text('author'),
  description: text('description'),
  coverUrl: text('cover_url'),
  isbn: text('isbn'),
  language: text('language').default('en'),
  publisher: text('publisher'),
  publishYear: integer('publish_year'),
  categories: text('categories').array(),
  fileHash: text('file_hash').notNull().unique(),
  totalPages: integer('total_pages'),
  userCount: integer('user_count').notNull().default(1),
  metadataSource: text('metadata_source').notNull().default('manual'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('idx_catalog_title_trgm').using('gin', sql`${table.title} gin_trgm_ops`),
  index('idx_catalog_author_trgm').using('gin', sql`${table.author} gin_trgm_ops`),
]);

// ============ BOOKS (per-user library) ============
export const books = pgTable('books', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  catalogId: uuid('catalog_id').notNull().references(() => bookCatalog.id, { onDelete: 'restrict' }),
  customTitle: text('custom_title'),
  coverUrl: text('cover_url'),
  structureSource: text('structure_source'),
  processingStatus: text('processing_status').default('pending'),
  lastReadAt: timestamp('last_read_at'),
  lastAccessedSectionId: uuid('last_accessed_section_id'),
  lastAccessedScrollProgress: real('last_accessed_scroll_progress').default(0),
  lastAccessedWordIndex: integer('last_accessed_word_index'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('idx_books_user_catalog').on(table.userId, table.catalogId),
]);

// ============ CHAPTERS ============
export const chapters = pgTable('chapters', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  startPage: integer('start_page'),
  endPage: integer('end_page'),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ SECTIONS ============
export const sections = pgTable('sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  chapterId: uuid('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  startPage: integer('start_page'),
  endPage: integer('end_page'),
  isRead: boolean('is_read').notNull().default(false),
  readAt: timestamp('read_at'),
  lastPageViewed: integer('last_page_viewed'),
  scrollProgress: real('scroll_progress').default(0),
  extractedText: text('extracted_text'),
  sectionType: text('section_type').notNull().default('content'), // 'content' | 'exercises' | 'solutions'
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ VOCABULARY ============
export const vocabulary = pgTable('vocabulary', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').references(() => books.id, { onDelete: 'set null' }),
  word: text('word').notNull(),
  pronunciation: text('pronunciation'),
  translation: text('translation'),
  targetLanguage: text('target_language'),
  definition: text('definition'),
  contextSentence: text('context_sentence'),
  explanation: text('explanation'),
  bookTitle: text('book_title'),
  sectionTitle: text('section_title'),
  page: integer('page'),
  reviewCount: integer('review_count').notNull().default(0),
  lastReviewedAt: timestamp('last_reviewed_at'),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ============ EXERCISES (shared, linked to catalog) ============
export const exercises = pgTable('exercises', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').notNull().references(() => bookCatalog.id, { onDelete: 'cascade' }),
  chapterTitle: text('chapter_title'),
  exerciseNumber: text('exercise_number'),
  content: text('content').notNull(),
  contentLatex: text('content_latex'),
  page: integer('page'),
  exerciseType: text('exercise_type').notNull().default('problem'),
  difficulty: text('difficulty'),
  hints: jsonb('hints'),
  solutionPage: integer('solution_page'),
  sortOrder: integer('sort_order').notNull().default(0),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============ EXERCISE PROGRESS (per-user) ============
export const exerciseProgress = pgTable('exercise_progress', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  exerciseId: uuid('exercise_id').notNull().references(() => exercises.id, { onDelete: 'cascade' }),
  bookId: uuid('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('not_started'),
  notes: text('notes'),
  completedAt: timestamp('completed_at'),
  timeSpentSeconds: integer('time_spent_seconds').notNull().default(0),
  metadata: jsonb('metadata').notNull().default({}),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('idx_exercise_progress_unique').on(table.userId, table.exerciseId),
]);

// ============ NIB CACHE (shared) ============
export const nibCache = pgTable('nib_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileHash: text('file_hash').notNull().unique(),
  r2Key: text('r2_key').notNull(),
  pageCount: integer('page_count'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============ PDF FILES (R2 references) ============
export const pdfFiles = pgTable('pdf_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileHash: text('file_hash').notNull().unique(),
  r2Key: text('r2_key').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  uploadedAt: timestamp('uploaded_at').notNull().defaultNow(),
});

// ============ PROCESSING JOBS ============
export const processingJobs = pgTable('processing_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  fileHash: text('file_hash').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  processingCostCents: integer('processing_cost_cents'),
  paid: boolean('paid').notNull().default(false),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('idx_processing_jobs_status').on(table.status, table.createdAt),
]);

// ============ PROCESSING CHARGES (billing ledger) ============
export const processingCharges = pgTable('processing_charges', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').notNull().references(() => processingJobs.id, { onDelete: 'cascade' }),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});
```

- [ ] **Step 4: Generate initial migration**

```bash
npm run db:generate
```

- [ ] **Step 5: Run migration against local PostgreSQL**

Make sure you have a local PostgreSQL running (Docker recommended):

```bash
docker run --name nibble-pg -e POSTGRES_DB=nibble -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
```

Update `.env` with `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nibble`, then:

```bash
npm run db:migrate
```

- [ ] **Step 6: Verify with Drizzle Studio**

```bash
npm run db:studio
```

Check all 13 tables are created with correct columns and constraints.

- [ ] **Step 7: Commit**

```bash
git add drizzle.config.ts src/db/
git commit -m "feat: Drizzle schema with all 13 tables and initial migration"
```

---

## Chunk 3: Repositories & Auth Service

### Task 3.1: User repository and auth service

**Files:**
- Create: `src/repositories/user.repository.ts`
- Create: `src/services/auth.service.ts`
- Create: `tests/unit/services/auth.service.test.ts`

- [ ] **Step 1: Implement user repository**

```typescript
// src/repositories/user.repository.ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export const userRepository = {
  async findByEmail(email: string) {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return user ?? null;
  },

  async upsertFromJwt(data: { email: string; name: string; sub: string; role: string; googleId?: string }) {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      // Link Google account if not yet linked
      if (data.googleId && !existing.googleId) {
        await db.update(users).set({ googleId: data.googleId }).where(eq(users.id, existing.id));
      }
      return existing;
    }
    const [created] = await db.insert(users).values({
      email: data.email,
      name: data.name,
      googleId: data.googleId,
      authRole: data.role,
    }).returning();
    return created;
  },

  async findById(id: string) {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user ?? null;
  },
};
```

- [ ] **Step 2: Implement auth service**

```typescript
// src/services/auth.service.ts
import { userRepository } from '../repositories/user.repository.js';
import type { JwtClaims } from '../lib/jwt.js';

export const authService = {
  async getOrCreateUser(claims: JwtClaims) {
    return userRepository.upsertFromJwt({
      email: claims.email,
      name: claims.name,
      sub: claims.sub,
      role: claims.role,
    });
  },
};
```

- [ ] **Step 3: Update auth middleware to use auth service**

Update `src/middleware/auth.ts` to call `authService.getOrCreateUser(claims)` instead of the temporary JWT-only user object. The middleware now upserts the user in the database on every request and attaches the full DB user record.

- [ ] **Step 4: Write auth service test**

- [ ] **Step 5: Run tests, commit**

```bash
git add src/repositories/ src/services/ src/middleware/auth.ts tests/
git commit -m "feat: user repository, auth service, DB-backed auth middleware"
```

---

### Task 3.2: Remaining CRUD repositories

**Files:**
- Create: All remaining repository files listed in the file map

Each repository follows the same pattern:
- `findById(id)`, `findByUserId(userId)` — standard lookups
- `create(data)`, `update(id, data)`, `softDelete(id)` — mutations
- `findModifiedSince(userId, since: Date)` — for sync (returns records including soft-deleted ones)

- [ ] **Step 1: Implement book.repository.ts** (books + book_catalog queries)
- [ ] **Step 2: Implement chapter.repository.ts**
- [ ] **Step 3: Implement section.repository.ts**
- [ ] **Step 4: Implement vocabulary.repository.ts**
- [ ] **Step 5: Implement settings.repository.ts**
- [ ] **Step 6: Implement exercise.repository.ts** (exercises + exercise_progress)
- [ ] **Step 7: Implement billing.repository.ts** (processing_jobs + processing_charges)
- [ ] **Step 8: Write tests for each repository**
- [ ] **Step 9: Commit**

```bash
git add src/repositories/ tests/
git commit -m "feat: all CRUD repositories with soft delete and sync support"
```

---

## Chunk 4: CRUD Routes

### Task 4.1: Books routes (the most complex CRUD)

**Files:**
- Create: `src/routes/books.ts`
- Create: `src/services/book.service.ts`

Key routes:
- `GET /api/books` — list user's books (excluding soft-deleted)
- `GET /api/books/:id` — get single book with catalog metadata joined
- `POST /api/books` — create a book entry in user's library (links to catalog)
- `PUT /api/books/:id` — update reading position, custom title, etc.
- `DELETE /api/books/:id` — soft delete

- [ ] **Step 1: Write book service**
- [ ] **Step 2: Write books route with Zod validation**
- [ ] **Step 3: Mount in index.ts behind auth middleware**
- [ ] **Step 4: Write integration tests**
- [ ] **Step 5: Commit**

### Task 4.2: Chapters & Sections routes

**Files:**
- Create: `src/routes/chapters.ts`
- Create: `src/routes/sections.ts`

Standard CRUD. Sections are scoped to chapters, chapters to books. All user-scoped (middleware enforces `userId`).

- [ ] **Step 1-5: Same pattern as books — service, route, tests, commit**

### Task 4.3: Vocabulary routes

**Files:**
- Create: `src/routes/vocabulary.ts`

- [ ] **Step 1-5: Same pattern — CRUD with all VocabEntry fields, soft delete**

### Task 4.4: Settings routes

**Files:**
- Create: `src/routes/settings.ts`

Just `GET /api/settings` and `PUT /api/settings`. One settings record per user (upsert on PUT).

- [ ] **Step 1-5: Implement, test, commit**

### Task 4.5: Mount all routes in index.ts

- [ ] **Step 1: Update src/index.ts to mount all CRUD routes behind authMiddleware**

```typescript
// Protected routes
app.use('/books/*', authMiddleware);
app.use('/chapters/*', authMiddleware);
app.use('/sections/*', authMiddleware);
app.use('/vocabulary/*', authMiddleware);
app.use('/settings/*', authMiddleware);

app.route('/books', bookRoutes);
app.route('/chapters', chapterRoutes);
app.route('/sections', sectionRoutes);
app.route('/vocabulary', vocabularyRoutes);
app.route('/settings', settingsRoutes);
```

- [ ] **Step 2: Integration test — full CRUD cycle for each entity**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: all CRUD routes with auth, validation, and soft delete"
```

---

## Chunk 5: Sync Engine

### Task 5.0: Test database helpers

**Files:**
- Create: `tests/integration/helpers/setup.ts`

Before writing integration tests, we need a test DB setup.

- [ ] **Step 1: Create test helper**

```typescript
// tests/integration/helpers/setup.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../../src/db/schema.js';
import { sql } from 'drizzle-orm';

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nibble_test';
const client = postgres(TEST_DB_URL);
export const testDb = drizzle(client, { schema });

// Truncate all tables between tests
export async function cleanDb() {
  await testDb.execute(sql`TRUNCATE users, user_settings, book_catalog, books, chapters, sections, vocabulary, exercises, exercise_progress, nib_cache, pdf_files, processing_jobs, processing_charges CASCADE`);
}

// Factory: create a test user and return their JWT
export async function createTestUser(overrides?: Partial<typeof schema.users.$inferInsert>) {
  const [user] = await testDb.insert(schema.users).values({
    email: `test-${Date.now()}@example.com`,
    name: 'Test User',
    authRole: 'user',
    ...overrides,
  }).returning();
  return user;
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/integration/helpers/
git commit -m "feat: test database helpers — setup, cleanup, factories"
```

---

### Task 5.1: Sync service — conflict resolution

**Files:**
- Create: `src/services/sync.service.ts`
- Create: `src/routes/sync.ts`
- Create: `tests/unit/services/sync.service.test.ts`

This is the most logic-heavy service. It implements:
1. Accept client changes (entities modified since `lastSyncedAt`)
2. For each entity type, compare `updated_at` timestamps
3. Last-write-wins, except reading progress prefers "more complete" state
4. Return server-side changes the client doesn't have
5. Include soft-deleted records in sync responses
6. Include exercises and nib_cache as server-to-client (read-only) data

**Key types:**

```typescript
interface SyncPayload {
  lastSyncedAt: string;  // ISO timestamp
  changes: {
    books: SyncEntity[];
    chapters: SyncEntity[];
    sections: SyncEntity[];
    vocabulary: SyncEntity[];
    settings: Record<string, unknown> | null;
    exerciseProgress: SyncEntity[];
  };
}

interface SyncResponse {
  serverChanges: {
    books: SyncEntity[];
    chapters: SyncEntity[];
    sections: SyncEntity[];
    vocabulary: SyncEntity[];
    settings: Record<string, unknown> | null;
    exerciseProgress: SyncEntity[];
    exercises: SyncEntity[];      // server -> client only (read-only)
  };
  syncedAt: string;
}

interface SyncEntity {
  id: string;
  updatedAt: string;
  deletedAt?: string | null;
  [key: string]: unknown;
}
```

**Reading progress conflict resolution:**
- If both sides modified a section, compare: `isRead` (true > false), `scrollProgress` (higher wins), `lastPageViewed` (higher wins). If server has `isRead=true` and client has `isRead=false`, server wins regardless of timestamp.

- [ ] **Step 1: Write sync conflict resolution tests**

```typescript
// tests/unit/services/sync.service.test.ts
describe('resolveConflict', () => {
  it('client wins when client.updatedAt > server.updatedAt', () => { ... });
  it('server wins when server.updatedAt > client.updatedAt', () => { ... });
  it('reading progress: isRead=true always wins over isRead=false', () => { ... });
  it('reading progress: higher scrollProgress wins', () => { ... });
  it('soft delete propagates when deletedAt is newer', () => { ... });
  it('exercises are included as server-to-client only', () => { ... });
});
```

- [ ] **Step 2: Implement sync service**

- [ ] **Step 3: Write sync route with Zod validation**

`POST /api/sync` — validates the full sync payload using the types above.

- [ ] **Step 4: Integration tests — full sync round-trip**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: sync engine with last-write-wins conflict resolution"
```

---

### Task 5.2: Soft-delete cleanup job

**Files:**
- Create: `src/jobs/cleanup.ts`

A background job that hard-deletes records where `deleted_at` is older than 30 days. Runs on a schedule (e.g., once per hour).

- [ ] **Step 1: Implement cleanup job**

```typescript
// src/jobs/cleanup.ts
// For each soft-deletable table (books, chapters, sections, vocabulary, exercise_progress):
//   DELETE FROM <table> WHERE deleted_at < NOW() - INTERVAL '30 days'
```

- [ ] **Step 2: Schedule in index.ts** (e.g., `setInterval(runCleanup, 60 * 60 * 1000)`)
- [ ] **Step 3: Test and commit**

```bash
git commit -m "feat: 30-day soft-delete cleanup job"
```

---

## Chunk 6: Storage Service (Cloudflare R2)

### Task 6.1: R2 storage operations

**Files:**
- Create: `src/services/storage.service.ts`

- [ ] **Step 1: Implement storage service**

```typescript
// src/services/storage.service.ts
// Uses @aws-sdk/client-s3 with R2 endpoint
// Methods:
//   uploadPdf(fileHash: string, buffer: Buffer): Promise<string>  -> returns r2Key
//   uploadNib(fileHash: string, nibJson: string): Promise<string> -> returns r2Key
//   downloadPdf(r2Key: string): Promise<Buffer>
//   getNibUrl(r2Key: string): Promise<string>  -> presigned URL for client download
//   deleteObject(r2Key: string): Promise<void>
```

- [ ] **Step 2: Test with a small file upload/download cycle** (integration test, requires R2 credentials)
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: Cloudflare R2 storage service for PDFs and .nib files"
```

---

## Chunk 7: Book Matching & Upload Flow

### Task 7.1: Book matching (hash + fuzzy title)

**Files:**
- Modify: `src/services/book.service.ts`
- Modify: `src/routes/books.ts`

- [ ] **Step 1: Add matchBook method to book service**

```typescript
// 1. Check exact hash match in book_catalog
// 2. If no exact match, fuzzy search by title using pg_trgm:
//    SELECT *, similarity(title, $1) AS sim FROM book_catalog
//    WHERE similarity(title, $1) > 0.3 ORDER BY sim DESC LIMIT 5
// 3. Return: { exactMatch?: CatalogEntry, fuzzyMatches: CatalogEntry[] }
```

- [ ] **Step 2: Add POST /api/books/match route**
- [ ] **Step 3: Test fuzzy matching**
- [ ] **Step 4: Commit**

### Task 7.2: PDF upload endpoint

**Files:**
- Modify: `src/routes/books.ts`
- Create: `src/services/metadata.service.ts`

- [ ] **Step 1: Implement metadata service** (Google Books API lookup by title/author)
- [ ] **Step 2: Add POST /api/books/upload route**

Flow: receive multipart PDF -> hash it -> upload to R2 -> create catalog entry -> auto-populate metadata -> create processing job -> estimate cost -> return job ID.

- [ ] **Step 3: Integration test**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: book matching (hash + fuzzy) and PDF upload with metadata auto-population"
```

---

## Chunk 8: Billing (Stripe)

### Task 8.1: Stripe payment flow

**Files:**
- Create: `src/services/billing.service.ts`
- Create: `src/routes/billing.ts`

- [ ] **Step 1: Implement billing service**

```typescript
// Methods:
//   createPaymentIntent(userId, jobId, totalPages): Promise<{ clientSecret, amountCents }>
//   handleWebhook(payload, signature): Promise<void>  // marks job as paid
//   refund(paymentIntentId): Promise<void>  // for failed processing
//   getPaymentHistory(userId): Promise<ProcessingCharge[]>
```

- [ ] **Step 2: Implement billing routes**

```
POST /api/billing/create-payment  -> creates Stripe PaymentIntent
POST /api/billing/webhook         -> Stripe webhook (no auth, verified by signature)
GET  /api/billing/history         -> user's payment history
```

- [ ] **Step 3: Test webhook handling**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: Stripe billing — payment intents, webhooks, refunds"
```

---

## Chunk 9: Processing Pipeline (Core Product)

This is the most complex and valuable part of the system.

### Processing Modes: A Spectrum, Not Binary

Processing is NOT "processed or not." It's a **spectrum** — each level adds value, and users can stop at any level:

```
Level 0: Raw PDF (free, instant)
    User uploads PDF. No AI. No charge.
    Gets: PDF viewer + page-by-page heatmap tracking.
    User manually assigns pages to sections.
    │
Level 1: TOC-based structure (free, instant)
    PDF.js extracts native TOC/outline from the PDF.
    If the book has a good TOC → chapters/sections created automatically.
    User can start reading with section-level tracking immediately.
    │
Level 2: User-assigned structure (free, manual)
    User manually creates/edits sections with page ranges.
    Admin can view user-assigned structures across books
    to learn patterns and improve AI prompts.
    │
Level 3: AI-refined structure (paid, progressive)
    Claude processes the book batch-by-batch.
    Structure updates DYNAMICALLY as it processes:
    - New sections/chapters discovered? Added in real-time.
    - Block types classified (theorem, proof, exercise).
    - Exercises extracted into exercise bank.
    User can READ while processing continues in background.
    │
Level 4: Full math processing (paid, background)
    Math-heavy pages sent through Vision + Mathpix.
    LaTeX attached to math-containing blocks.
    Complete .nib with all objects ready.
```

**Any user can upload a PDF and start reading for free immediately.** AI processing is an upgrade, not a prerequisite.

### The Smart TOC Strategy

When a user uploads a PDF, the backend does this BEFORE any paid processing:

```
Phase 0 (instant, free): Quick TOC extraction
    │
    ├── Check PDF outline API (pdf.js getOutline())
    │   └── If robust TOC exists → create chapters/sections immediately
    │       User can START READING NOW
    │
    ├── If no outline → extract text from first 5-10 pages
    │   └── Look for table of contents formatting:
    │       "Chapter 1 ........... 1"
    │       "Chapter 2 ........... 45"
    │       (regex + heuristics, no AI needed)
    │
    └── If still nothing → user lands on Level 0 (raw PDF)
        They can manually assign sections or pay for AI processing
```

When the user opts for **AI processing**, it works progressively:

```
Phase 1 (seconds): First batch — verify/seed structure
    → Process first 20 pages of text with Claude
    → If we have a TOC from Phase 0: Claude VALIDATES it
      (fixes page offsets, adds missing sections, corrects titles)
    → If no TOC: Claude creates initial structure from the first 20 pages
    → UPDATE chapters/sections table immediately
    → User sees structure appearing in real-time
    │
Phase 2 (progressive, batch-by-batch): Full classification
    → Process remaining pages in batches of 20-40
    → After EACH batch:
      - Discovered a new chapter? → INSERT into chapters table
      - Section title refined? → UPDATE sections table
      - Exercises found? → INSERT into exercises table
      - Update processing_jobs.progress (0-100%)
    → The structure grows and refines as processing continues
    → Like dynamic programming — build the map while exploring
    │
Phase 3 (background): Math processing (expensive, optional)
    → Detect math pages from Phase 2 results
    → Claude Vision for bounding boxes on math pages only
    → Mathpix for cropped formula regions
    → Attach LaTeX to .nib blocks
    → Final .nib assembly and upload to R2
```

**The user experience:**
1. Upload PDF → instantly get PDF viewer + heatmap tracking
2. If TOC exists → sections appear immediately, start reading with progress tracking
3. Opt in to AI processing → pay, see structure building in real-time
4. Keep reading while processing happens in background
5. When done → full .nib with exercises, math LaTeX, block types

### Manual Section Assignment (Free Feature)

Users can define their own chapter/section structure at any time:

```
POST /api/chapters              → create chapter with { title, startPage, endPage }
POST /api/sections              → create section with { chapterId, title, startPage, endPage }
PUT  /api/sections/:id          → update page ranges
```

This works WITHOUT any AI processing. The user just assigns page ranges.

**Admin learning loop:** Admin can view user-created structures via `/api/admin/catalog` to see how users organize books. This data helps improve AI prompts — if 5 users all assign the same page ranges for "Stein's Complex Analysis," the AI should learn from that pattern.

**Merging manual + AI:** When a user has manually assigned sections and THEN opts for AI processing, the pipeline should:
1. Use the user's manual structure as a SEED (not start from scratch)
2. Claude validates/refines the user's assignments
3. Additions are additive — Claude never deletes user-created sections
4. User gets a "review changes" prompt if Claude suggests structural changes

### Cost Philosophy

> **IMPORTANT: Targeted approach, not brute-force.**
>
> - Mathpix is expensive (~4000 lines of JSON for 3 full pages). **DO NOT** send full pages or entire PDFs to Mathpix.
> - Claude Vision is also expensive (~1,600 tokens per page image). **DO NOT** send every page as an image.
> - Instead, use a **tiered approach**: cheap text analysis first, expensive vision only where needed.
>
> **The division of labor:**
> - **PDF.js** = foundation. Extracts text layer, positions, fonts. Free, local, fast. Works on ALL pages.
> - **Claude TEXT** = the strategist. Analyzes extracted TEXT (not images) to classify structure, block types, and identify exercises. Cheap (~$0.50 for 400 pages). Works on ALL pages.
> - **Heuristic math detection** = the filter. Scans text for math indicators (symbols like ∫ Σ ∞ √, garbled font chars, Claude's "has math" flags). Free, local. Flags only math-heavy pages (~50-100 out of 400).
> - **Claude Vision** = precision targeting. Sent ONLY the flagged math-heavy pages as images. Identifies exact bounding boxes for math regions. Used on ~20% of pages.
> - **Mathpix** = the math specialist. Sent ONLY cropped image snippets of math regions. Converts to LaTeX. Used on ~5-10% of total page area.
> - **.nib assembly** = the builder. Combines all outputs into the NibDocument hierarchy.
>
> **Cost estimate for a 400-page Complex Analysis book:**
>
> | Step | Scope | Cost |
> |------|-------|------|
> | PDF.js text extraction | All 400 pages | Free |
> | Claude TEXT (structure + classification) | All 400 pages of text | ~$0.50 |
> | Heuristic math page detection | All 400 pages | Free |
> | Claude Vision (math pages only) | ~80 pages with math | ~$1.00 |
> | Mathpix (cropped formula regions) | ~150 regions | ~$1.50 |
> | **Total** | | **~$3.00** |

### Dual TOC: Content Structure + Exercise/Question Bank

The parser (and Claude) should produce TWO parallel structures from a PDF:

**1. Content TOC** (what we already build):
```
Chapter 3: Complex Integration
  ├── 3.1 Contour Integrals
  ├── 3.2 Cauchy's Integral Formula
  └── 3.3 Residue Theorem
```

**2. Exercise TOC** (new — extracted alongside content):
```
Chapter 3: Complex Integration
  ├── 3.1 Exercises (page 87, 12 problems)
  │     ├── Exercise 3.1.1 — Evaluate the contour integral...
  │     ├── Exercise 3.1.2 — Prove that...
  │     └── ...
  ├── 3.2 Exercises (page 102, 8 problems)
  └── 3.3 Exercises (page 118, 15 problems)
```

**How it works during processing:**
- Claude TEXT (Phase 2) already classifies blocks as `exercise`, `problem`, `definition`, `theorem`, etc.
- When Claude encounters a repeated pattern of exercises within a section (e.g., "Exercises 3.1" appearing after section 3.1 content), it should:
  1. Create an **exercise subsection** in the section hierarchy
  2. Tag it with `blockType: 'exercise-section'`
  3. Each individual exercise becomes an entry in the `exercises` table linked to that subsection
- The exercise TOC is built from these exercise subsections

**Data model impact:**
- `chapters` and `sections` already support this — an exercise section is just a section with a special type
- Add `section_type` column to `sections` table: `'content' | 'exercises' | 'solutions'`
- This distinguishes regular content sections from exercise/solution sections in the TOC
- The frontend can then render two TOC views: content-only and exercises-only

**Future features this enables:**
- Question bank: browse all exercises across all books
- Flashcard generation from exercises
- Spaced repetition scheduling per exercise
- Exercise completion heatmap (separate from reading heatmap)
- Cross-book exercise sets ("all contour integral problems from your library")

> **Schema change needed:** Add to `sections` table:
> ```sql
> section_type TEXT NOT NULL DEFAULT 'content'  -- 'content' | 'exercises' | 'solutions'
> ```
> This is a minor migration. The existing `sort_order` field handles positioning within the TOC.

---

### Learn Mode: Self-Improving Parser (Admin/Developer Tool)

> **This is a future developer tool, not part of the initial launch.**
> Document the architecture now so it's not lost.

**The problem:** Our NibParser/NibTextParser will make mistakes — garbled text, misclassified blocks, broken paragraph boundaries. Every PDF is different. We need the parser to improve over time.

**The solution: "Learn Mode"** — an admin-only processing mode where Claude acts as a QA engineer that also fixes the bugs it finds.

```
Admin uploads PDF in "Learn Mode"
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Step 1: Run BOTH pipelines simultaneously        │
│                                                  │
│ Pipeline A: TOC Parser (our code)                │
│   → NibParser processes PDF                      │
│   → Renders text output for each page            │
│                                                  │
│ Pipeline B: Claude Processing (AI)               │
│   → Full AI pipeline (text + vision)             │
│   → Produces its own structure + classification   │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│ Step 2: Claude Vision QA — Compare outputs       │
│                                                  │
│ For each page, Claude Vision receives:           │
│   - Original PDF page (rendered image)           │
│   - Our parser's text output (rendered)          │
│                                                  │
│ Claude examines:                                 │
│   - Is text garbled or missing?                  │
│   - Are paragraphs split in wrong places?        │
│   - Are block types misclassified?               │
│   - Is math content mangled?                     │
│   - Do headings match the original?              │
│                                                  │
│ Output: List of issues with page numbers:        │
│   "Page 42: Theorem text is split across two     │
│    paragraphs. Should be one block."             │
│   "Page 87: Exercise numbering is off by one."   │
│   "Page 103: Integral symbol rendered as garbage" │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│ Step 3: Claude Code — Fix the parser             │
│                                                  │
│ For each issue found:                            │
│   1. Claude examines the parser source code      │
│      (NibParser, NibTextParser, etc.)            │
│   2. Creates a new git branch                    │
│   3. Modifies the parser code to fix the issue   │
│   4. Runs the parser on the same PDF             │
│   5. Re-renders the problematic pages            │
│   6. Claude Vision verifies: is it fixed?        │
│   7. If not fixed → iterate (modify, run, check) │
│   8. If fixed → continue to next issue           │
│   9. If stuck (>5 attempts) → log and skip       │
│                                                  │
│ After all issues addressed:                      │
│   → Run full test suite to check no regressions  │
│   → Create PR on GitHub with:                    │
│     - Issue descriptions                         │
│     - Before/after screenshots                   │
│     - Parser code changes                        │
│   → Human reviews and merges                     │
└──────────────────────────────────────────────────┘
```

**Implementation notes:**
- This is essentially a **Claude Code agent running inside the backend** (or triggered by the backend)
- The backend provides the orchestration: upload PDF, run both pipelines, feed results to Claude
- Claude Code (or the Anthropic agent SDK) does the actual code modification loop
- The PR is the output — human always reviews before merging
- Each Learn Mode run costs more (double processing + code iteration) but improves the parser for ALL future users

**Admin UI for Learn Mode:**
```
POST /api/admin/learn { bookId }     → start Learn Mode processing
GET  /api/admin/learn/:id            → check progress, view issues found
GET  /api/admin/learn/:id/issues     → detailed issue list with before/after
POST /api/admin/learn/:id/approve    → approve the generated PR
```

**When to use Learn Mode:**
- When a user reports parsing issues on a specific book
- When testing the parser against a new category of technical book
- Periodically on a sample of recently uploaded books to catch drift
- After parser code changes to verify improvements

> **This creates a flywheel:** More books processed → more Learn Mode runs → better parser → better output for all users. The parser gets smarter with every book.

### The Pipeline (step by step)

```
PDF Buffer (from R2)
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 1: PDF.js Text Extraction (ALL pages, free, local)  │
│                                                          │
│ Input:  PDF buffer                                       │
│ Output: Per-page data:                                   │
│   - Raw text with position/font/style info               │
│   - Text items with bounding boxes                       │
│   - Page dimensions                                      │
│   - Whether a native TOC/outline exists                  │
│                                                          │
│ Reuses same logic as frontend NibParser via pdfjs-dist.  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 2: Claude TEXT — Structure + Classification         │
│ (ALL pages, cheap — text tokens only, no images)         │
│                                                          │
│ Input:  Extracted TEXT from Step 1 (not images!)          │
│         + native TOC if available                        │
│ Output: Per-page classification:                         │
│                                                          │
│ {                                                        │
│   "page": 42,                                            │
│   "blocks": [                                            │
│     { "type": "theorem",                                 │
│       "title": "Theorem 3.2 (Cauchy's Integral)",        │
│       "startLine": 5, "endLine": 12,                     │
│       "hasMath": true },                                 │
│     { "type": "proof",                                   │
│       "startLine": 13, "endLine": 35,                    │
│       "hasMath": true },                                 │
│     { "type": "exercise",                                │
│       "exerciseNumber": "3.2.1",                         │
│       "startLine": 36, "endLine": 42,                    │
│       "hasMath": true },                                 │
│     { "type": "body",                                    │
│       "startLine": 43, "endLine": 55,                    │
│       "hasMath": false }                                 │
│   ],                                                     │
│   "chapterTitle": "Chapter 3: Complex Integration",      │
│   "sectionTitle": "3.2 Cauchy's Integral Formula"        │
│ }                                                        │
│                                                          │
│ Block types: body, theorem, proof, definition, example,  │
│   exercise, figure, blockquote, list-item, epigraph,     │
│   introduction, corollary, lemma, remark                 │
│                                                          │
│ Cost: ~$0.30-0.50 for a 400-page book (text is cheap).   │
│ Processing: 20-40 pages of text per batch.               │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3: Math Page Detection (free, local heuristic)      │
│                                                          │
│ Flag pages that need Vision + Mathpix processing:        │
│ - Pages where Claude said hasMath: true                  │
│ - Pages with math symbols in text: ∫ Σ ∞ √ ∂ ∈ ≤ ≥     │
│ - Pages with garbled characters (math fonts extract      │
│   as garbage in PDF.js — common indicator)               │
│                                                          │
│ Typical result: ~50-100 out of 400 pages flagged.        │
│ The other 300+ pages are pure text — no Vision needed.   │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 4: Claude Vision — ONLY math-heavy pages            │
│ (~80 pages, not 400)                                     │
│                                                          │
│ Input:  Page IMAGES of only the flagged pages             │
│         + text context from Step 1                       │
│ Output: Math region bounding boxes:                      │
│                                                          │
│ { "page": 42, "mathRegions": [                           │
│     { "x": 100, "y": 140, "w": 300, "h": 30 },         │
│     { "x": 90,  "y": 350, "w": 400, "h": 40 }          │
│ ]}                                                       │
│                                                          │
│ Cost: ~$0.80-1.50 for ~80 pages (vs $4-8 for 400).      │
│ Processing: 10 page images per batch.                    │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 5: Targeted Mathpix — cropped math regions only     │
│                                                          │
│ For each mathRegion bbox from Step 4:                    │
│   1. Crop the page image to the bounding box             │
│   2. POST cropped snippet to Mathpix /v3/text            │
│   3. Get back LaTeX for that specific formula            │
│                                                          │
│ Pages with NO math skip Mathpix entirely.                │
│ Cost: ~$0.01/region × ~150 regions = ~$1.50              │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 6: .nib Assembly                                    │
│                                                          │
│ Combine: text (Step 1) + block types (Step 2)            │
│          + LaTeX (Step 5)                                │
│                                                          │
│ Build hierarchy:                                         │
│   NibDocument                                            │
│     └── NibPage[]                                        │
│           └── NibParagraph[]  (tagged with blockType)    │
│                 └── NibSentence[]                        │
│                       └── NibWord[]                      │
│                             ├── text, pdfRect            │
│                             ├── latex (if math)          │
│                             └── blockType                │
│                                                          │
│ Exercises → extracted into `exercises` table             │
│ Chapter/section structure → from Step 2 or native TOC    │
│ Serialize NibDocument to JSON.                           │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 7: Store Results                                    │
│   - Upload .nib JSON to Cloudflare R2                    │
│   - Store exercises in `exercises` table                 │
│   - Store R2 key in `nib_cache`                          │
│   - Update `processing_jobs` status -> completed         │
└──────────────────────────────────────────────────────────┘
```

### Upload Flow (updated for free + paid modes)

**Free upload (no AI):**
1. User uploads PDF → `POST /api/books/upload`
2. Server: hash PDF, check catalog for dedup
3. Upload PDF to R2
4. Extract TOC via PDF.js outline (instant, free)
5. If TOC found → auto-create chapters/sections from it
6. Return book entry to client → user can start reading immediately
7. No processing job, no payment, no AI

**Paid AI processing (upgrade from free):**
1. User has a book (uploaded via free flow)
2. User clicks "Process with AI" → `POST /api/processing/start`
3. Server estimates cost, creates payment intent
4. User pays via Stripe
5. Processing starts progressively:
   - Phase 1: First batch validates/seeds structure → sections update in real-time
   - Phase 2: Remaining batches → structure grows dynamically
   - Phase 3: Math processing on flagged pages
6. Client polls progress → sees structure building live

**The `processing_status` field on `books` now has more states:**
```
'none'       → Level 0/1/2: no AI processing, raw PDF or manual/TOC structure
'pending'    → paid but not yet started
'processing' → AI is actively working (Phases 1-3)
'complete'   → fully processed with .nib
'error'      → processing failed (auto-refund)
```

### What we DON'T know yet (requires experimentation)

> These are open questions that need testing with real technical PDFs:
>
> 1. **Claude Vision accuracy** — How well does Claude identify block types (theorem vs proof vs definition) and math region bounding boxes? Need to test with real Complex Analysis PDFs and iterate on the prompt.
> 2. **Math region cropping precision** — Claude's bounding boxes might not be pixel-perfect. May need a small padding margin around each crop.
> 3. **Inline math handling** — Short inline formulas like `f(z)` might be too small to crop and send to Mathpix. For inline math, we might rely on Claude to directly return the LaTeX (it's often simple enough).
> 4. **Batch size tuning** — 10 pages per Claude batch is a starting point. May need to adjust based on token limits and response quality.
> 5. **Fallback for bad OCR** — Some scanned PDFs have no text layer at all. In that case, we'd need to send full page images to Mathpix (expensive but unavoidable for scanned-only books).
>
> **Strategy: Build the pipeline with the targeted approach. Test with 3-5 real technical books. Iterate on prompts and parameters. The architecture supports swapping strategies per step without rewriting the whole pipeline.**

### Task 9.1: Mathpix service (targeted image-to-LaTeX)

**Files:**
- Create: `src/services/mathpix.service.ts`

- [ ] **Step 1: Implement Mathpix API client for image snippets**

```typescript
// src/services/mathpix.service.ts
// Uses fetch() to call Mathpix REST API
//
// IMPORTANT: Uses the IMAGE endpoint, NOT the PDF endpoint.
// We send cropped image snippets, not full pages.
//
// Methods:
//   convertImageToLatex(imageBuffer: Buffer): Promise<string>
//     -> POST https://api.mathpix.com/v3/text
//     -> Headers: app_id, app_key
//     -> Body: { src: "data:image/png;base64,..." }
//     -> Returns: LaTeX string
//
//   batchConvertRegions(regions: MathRegion[]): Promise<Map<string, string>>
//     -> Processes multiple cropped regions in parallel (with concurrency limit)
//     -> Returns: Map of regionId -> LaTeX string
//
// interface MathRegion {
//   id: string;           // unique ID for this region
//   imageBuffer: Buffer;  // cropped image of just the math formula
//   page: number;
//   bbox: { x: number; y: number; w: number; h: number };
// }
```

- [ ] **Step 2: Test with a cropped math formula image**
- [ ] **Step 3: Commit**

### Task 9.2: Claude TEXT — structure classification (cheap, all pages)

**Files:**
- Modify: `src/services/ai.service.ts`

- [ ] **Step 1: Implement text-based structure extraction**

```typescript
// Methods:
//   classifyPages(extractedText: string[], tocIfAvailable?: TOC): Promise<PageAnalysis[]>
//     -> Sends EXTRACTED TEXT (not images!) to Claude in batches of 20-40 pages
//     -> Claude classifies blocks: type, line ranges, hasMath flag
//     -> Returns: PageAnalysis[] with blocks, chapter/section titles
//     -> Cost: ~$0.50 for 400 pages (text tokens are cheap)
//
//   identifyExercises(pageAnalyses: PageAnalysis[]): Exercise[]
//     -> Filters for blocks with type 'exercise'
//     -> Extracts exercise number, content, page, chapterTitle
//     -> (Local extraction from Claude's output, not another API call)
```

- [ ] **Step 2: Test with extracted text from a real technical PDF**
- [ ] **Step 3: Commit**

### Task 9.2b: Math page detection + Claude Vision (expensive, math pages only)

**Files:**
- Modify: `src/services/ai.service.ts`
- Create: `src/services/image.service.ts` (PDF page rendering + cropping)

- [ ] **Step 1: Implement heuristic math page detector**

```typescript
// detectMathPages(extractedText: string[], pageAnalyses: PageAnalysis[]): number[]
//   -> Check each page for:
//      - Claude's hasMath: true flags from Step 2
//      - Math symbols in text: ∫ Σ ∞ √ ∂ ∈ ⊂ ≤ ≥ ≠ ∀ ∃
//      - Garbled characters (math font extraction artifacts)
//   -> Returns: array of page numbers that need Vision processing
//   -> Typically ~20% of pages in a math-heavy book
```

- [ ] **Step 2: Implement page-to-image rendering** (pdfjs-dist + canvas -> PNG)
- [ ] **Step 3: Implement Claude Vision for math bbox detection**

```typescript
// getMathBoundingBoxes(pageImages: Buffer[], pageNumbers: number[]): Promise<MathRegion[]>
//   -> Sends ONLY flagged page images to Claude Vision
//   -> Claude returns bounding boxes for each math region
//   -> 10 images per batch
```

- [ ] **Step 4: Implement math region cropping** (crop PNG at bounding boxes)
- [ ] **Step 5: Test with math-heavy pages from Complex Analysis**
- [ ] **Step 6: Commit**

### Task 9.3: .nib assembly

**Files:**
- Modify: `src/services/processing.service.ts`

The .nib format is defined in the frontend at `WordByWord/src/lib/nib/models.ts`. Read that file before implementing. The backend must produce the same structure:

```
NibDocument -> NibPage[] -> NibParagraph[] -> NibSentence[] -> NibWord[]
```

Each NibWord has: text, pdfRect (position), context references. NibParagraphs are tagged with blockType and may have LaTeX attached.

- [ ] **Step 1: Define .nib types** (mirror frontend models from `WordByWord/src/lib/nib/models.ts`)
- [ ] **Step 2: Implement assembly pipeline**

```typescript
// orchestratePipeline(fileHash: string):
//   1. Download PDF from R2
//   2. Extract text with pdfjs-dist (ALL pages — free, local)
//   3. Send extracted TEXT to Claude for structure + block classification (cheap)
//   4. Detect math-heavy pages via heuristics (free, local)
//   5. Render ONLY math-heavy pages to images
//   6. Send math page images to Claude Vision for bounding boxes (~20% of pages)
//   7. Crop math regions from images using Claude's bounding boxes
//   8. Send cropped math snippets to Mathpix for LaTeX conversion
//   9. Extract exercises from Claude's text analysis
//   10. Assemble .nib JSON: text (2) + block types (3) + LaTeX (8)
//   11. Upload .nib to R2
//   12. Store exercises in DB
//   13. Update nib_cache with R2 key
//   14. Mark processing job as completed
```

- [ ] **Step 3: Test pipeline with a small PDF end-to-end**
- [ ] **Step 4: Commit**

### Task 9.4: Background job queue and worker

**Files:**
- Create: `src/jobs/queue.ts`
- Create: `src/jobs/process-pdf.ts`

- [ ] **Step 1: Implement job queue**

```typescript
// src/jobs/queue.ts
// pollForJobs(): SELECT from processing_jobs WHERE status='pending' AND paid=true ORDER BY created_at LIMIT 1
// markProcessing(jobId): UPDATE status='processing'
// markCompleted(jobId): UPDATE status='completed', progress=100
// markFailed(jobId, error): UPDATE status='failed', error=error
// retryStuckJobs(): UPDATE status='pending' WHERE status='processing' AND updated_at < NOW() - INTERVAL '10 minutes'
```

- [ ] **Step 2: Implement worker loop**

```typescript
// src/jobs/process-pdf.ts
// Runs on an interval (e.g., every 5 seconds)
// 1. retryStuckJobs()
// 2. pollForJobs()
// 3. If job found: markProcessing(), call processing.service.orchestratePipeline()
// 4. On success: markCompleted()
// 5. On error: markFailed(), trigger billing.service.refund()
```

- [ ] **Step 3: Start worker in index.ts** (runs in same process)

```typescript
// In src/index.ts, after server starts:
import { startWorker } from './jobs/process-pdf.js';
startWorker(); // polls every 5 seconds
```

- [ ] **Step 4: Test full flow — upload -> pay -> process -> download .nib**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: processing pipeline — Mathpix + Claude + .nib assembly + background worker"
```

---

## Chunk 10: Rate Limiting

### Task 10.1: Per-user rate limiter

**Files:**
- Create: `src/middleware/rate-limit.ts`
- Create: `tests/unit/lib/rate-limit.test.ts`

Rate limiting must be in place before AI proxy routes (which are abuse-sensitive).

- [ ] **Step 1: Write rate limiter test**

```typescript
describe('rateLimiter', () => {
  it('allows requests under the limit', () => { ... });
  it('blocks requests over the limit', () => { ... });
  it('resets after the window expires', () => { ... });
});
```

- [ ] **Step 2: Implement in-memory sliding-window rate limiter**

```typescript
// Default limits (configurable per route group):
// AI proxy routes: 60 req/min
// Sync: 10 req/min
// Upload: 5 req/min
// Everything else: 120 req/min
```

- [ ] **Step 3: Test and commit**

```bash
git commit -m "feat: per-user rate limiting middleware"
```

---

## Chunk 11: AI Proxy & Processing Status

### Task 11.1: AI proxy routes

**Files:**
- Modify: `src/services/ai.service.ts`
- Create: `src/routes/ai.ts`

- [ ] **Step 1: Add proxy methods to ai.service**

```typescript
// wordContext(word, sentence, bookContext): Promise<{ definition, translation, explanation }>
// translate(text, targetLanguage): Promise<string>
// explain(text, bookContext): Promise<string>
//
// All methods: check cache first, call Claude if miss, cache response.
```

- [ ] **Step 2: Implement AI routes with rate limiting**
- [ ] **Step 3: Implement processing status route**

```
GET /api/processing/:jobId -> { status, progress, error?, nibUrl? }
```

- [ ] **Step 4: Tests and commit**

```bash
git commit -m "feat: AI proxy routes (word-context, translate, explain) with caching"
```

---

## Chunk 12: Admin Routes

### Task 12.1: Admin catalog and job management

**Files:**
- Create: `src/routes/admin.ts`

- [ ] **Step 1: Implement admin routes**

All behind `authMiddleware` + `adminMiddleware`:

```
GET    /api/admin/catalog          -> paginated list, fuzzy search
GET    /api/admin/catalog/:id      -> detail with exercise count, user count
PUT    /api/admin/catalog/:id      -> edit metadata
DELETE /api/admin/catalog/:id      -> remove (CASCADE to nib_cache, exercises)
GET    /api/admin/jobs             -> all processing jobs with filters
GET    /api/admin/stats            -> { totalUsers, totalBooks, totalProcessed, revenue }
```

- [ ] **Step 2: Tests and commit**

```bash
git commit -m "feat: admin routes — catalog CRUD, job viewer, usage stats"
```

---

## Chunk 13: Dockerfile & Deployment Config

### Task 13.1: Docker and Railway setup

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create multi-stage Dockerfile**

```dockerfile
# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Test Docker build locally**

```bash
docker build -t nibble-api .
docker run -p 4000:4000 --env-file .env nibble-api
curl http://localhost:4000/api/health
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: Dockerfile for Railway deployment"
```

---

## Implementation Order Summary

Build in this order — each chunk produces working, testable software:

| # | Chunk | What you get when done |
|---|-------|----------------------|
| 1 | Scaffold & Foundation | Server starts, health check works, JWT verification works |
| 2 | Database Schema | All 13 tables created, migrations run |
| 3 | Repositories & Auth | Users can authenticate, DB records created |
| 4 | CRUD Routes | Full REST API for books, chapters, sections, vocab, settings |
| 5 | Sync Engine | Offline-first sync works across devices + 30-day cleanup |
| 6 | Storage (R2) | PDFs and .nib files stored in cloud |
| 7 | Book Matching & Upload | Hash dedup + fuzzy matching + PDF upload |
| 8 | Billing (Stripe) | Users can pay for processing |
| 9 | Processing Pipeline | **THE CORE PRODUCT** — PDF -> .nib with math + exercises |
| 10 | Rate Limiting | API abuse protection (must be before AI proxy) |
| 11 | AI Proxy | Word definitions, translations, explanations |
| 12 | Admin Routes | Catalog management, job monitoring, stats |
| 13 | Deployment | Docker + Railway ready |

**Important status value distinction:**
- `processing_jobs.status` uses: `'pending' | 'processing' | 'completed' | 'failed'` (server-internal lifecycle)
- `books.processing_status` uses: `'pending' | 'processing' | 'complete' | 'error'` (matches frontend enum)
- These are intentionally different. The book service maps between them when updating a book's status from its processing job.

---

## Key API Reference

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/health` | No | Health check |
| POST | `/api/sync` | Yes | Bidirectional sync |
| GET | `/api/books` | Yes | List user's books |
| GET | `/api/books/:id` | Yes | Get book detail |
| POST | `/api/books` | Yes | Add book to library |
| PUT | `/api/books/:id` | Yes | Update book |
| DELETE | `/api/books/:id` | Yes | Soft-delete book |
| POST | `/api/books/match` | Yes | Check hash + fuzzy match |
| POST | `/api/books/upload` | Yes | Upload PDF for processing |
| GET/PUT/DELETE | `/api/chapters/*` | Yes | Chapter CRUD |
| GET/PUT/DELETE | `/api/sections/*` | Yes | Section CRUD |
| GET/POST/PUT/DELETE | `/api/vocabulary/*` | Yes | Vocabulary CRUD |
| GET/PUT | `/api/settings` | Yes | User settings |
| POST | `/api/ai/word-context` | Yes | AI word lookup |
| POST | `/api/ai/translate` | Yes | AI translation |
| POST | `/api/ai/explain` | Yes | AI explanation |
| POST | `/api/processing/start` | Yes | Start AI processing for an existing book (triggers payment) |
| GET | `/api/processing/:jobId` | Yes | Check processing status + progressive updates |
| POST | `/api/billing/create-payment` | Yes | Create Stripe payment |
| POST | `/api/billing/webhook` | No* | Stripe webhook (*verified by signature) |
| GET | `/api/billing/history` | Yes | Payment history |
| GET | `/api/admin/catalog` | Admin | Browse catalog |
| GET | `/api/admin/catalog/:id` | Admin | Catalog entry detail |
| PUT | `/api/admin/catalog/:id` | Admin | Edit catalog entry |
| DELETE | `/api/admin/catalog/:id` | Admin | Remove catalog entry |
| GET | `/api/admin/jobs` | Admin | View processing jobs |
| GET | `/api/admin/stats` | Admin | Usage metrics |
