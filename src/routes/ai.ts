import { Hono } from 'hono';
import { z } from 'zod';
import { aiService, type AiCallContext } from '../services/ai.service.js';
import { AppError } from '../lib/errors.js';
import { assertUuidPathParam } from '../lib/query-guards.js';
import { AI_PROVIDERS, PROVIDER_LABEL, type AiProvider } from '../ai/detect.js';
import * as repo from '../ai/repo.js';
import { KeyCheckError, addKey, recheckKey } from '../ai/service.js';

/**
 * AI routes. Since 2026-11-17 every model call here runs on the signed-in
 * reader's OWN provider key (bring your own key, src/ai/): there is no server
 * key and no admin-only gate. Without a working key a call answers
 * AI_KEY_REQUIRED (409). /keys, /settings and /usage manage the keys and show
 * what they have been spent on.
 */
export const aiRoutes = new Hono();

// Client-disconnect aborts surface as a DOMException named 'AbortError' from
// fetch. The client is gone — short-circuit with 499 (client closed request)
// so the global error handler doesn't log this as an unhandled 500.
function isClientAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function ctxOf(c: { get: (k: 'user') => { id: string }; req: { raw: Request } }): AiCallContext {
  return { userId: c.get('user').id, signal: c.req.raw.signal };
}

async function runOr499(fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (err) {
    if (isClientAbort(err)) return null;
    throw err;
  }
}

function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  return parsed.data;
}

// ─── Keys, settings, usage ─────────────────────────────────────────

aiRoutes.get('/keys', async (c) => {
  const userId = c.get('user').id;
  const [keys, settings] = await Promise.all([repo.listKeys(userId), repo.getSettings(userId)]);
  return c.json({ keys: keys.map(repo.publicKey), settings, providers: PROVIDER_LABEL });
});

const KEY_CHECK_STATUS: Record<KeyCheckError['code'], { code: string; status: number }> = {
  unknown_provider: { code: 'AI_KEY_UNKNOWN_PROVIDER', status: 400 },
  auth: { code: 'AI_KEY_REJECTED', status: 422 },
  quota: { code: 'AI_KEY_NO_CREDIT', status: 422 },
  no_models: { code: 'AI_KEY_NO_MODELS', status: 422 },
  unreachable: { code: 'AI_PROVIDER_UNREACHABLE', status: 502 },
};

// Paste a key: the provider is detected from its format, then the key is
// proved by one real (one-token) call before it is sealed and stored.
aiRoutes.post('/keys', async (c) => {
  const { key } = parseOr400(z.object({ key: z.string().trim().min(1).max(400) }).strict(), await c.req.json());
  try {
    const row = await addKey(c.get('user').id, key);
    return c.json({ key: repo.publicKey(row) }, 201);
  } catch (err) {
    if (err instanceof KeyCheckError) {
      const { code, status } = KEY_CHECK_STATUS[err.code];
      throw new AppError(code, err.message, status);
    }
    throw err;
  }
});

aiRoutes.patch('/keys/:id', async (c) => {
  const userId = c.get('user').id;
  const id = assertUuidPathParam(c.req.param('id'), 'id');
  const { preferredModel } = parseOr400(
    z.object({ preferredModel: z.string().max(120).nullable() }).strict(),
    await c.req.json(),
  );
  const row = await repo.getKey(userId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Key not found', 404);
  if (preferredModel !== null && !repo.modelsOf(row).includes(preferredModel)) {
    throw new AppError('BAD_REQUEST', 'That model is not available to this key', 400);
  }
  // The model list checked above belongs to this exact key; if it was replaced
  // or deleted since, the choice no longer applies.
  const updated = await repo.updateKey(userId, id, { preferredModel }, row.keySealed);
  if (!updated) throw new AppError('CONFLICT', 'This key changed while you were choosing. Reload and pick again.', 409);
  return c.json({ key: repo.publicKey(updated) });
});

aiRoutes.post('/keys/:id/check', async (c) => {
  const id = assertUuidPathParam(c.req.param('id'), 'id');
  const updated = await recheckKey(c.get('user').id, id);
  if (!updated) throw new AppError('NOT_FOUND', 'Key not found', 404);
  return c.json({ key: repo.publicKey(updated) });
});

aiRoutes.delete('/keys/:id', async (c) => {
  const id = assertUuidPathParam(c.req.param('id'), 'id');
  const ok = await repo.deleteKey(c.get('user').id, id);
  if (!ok) throw new AppError('NOT_FOUND', 'Key not found', 404);
  return c.body(null, 204);
});

aiRoutes.patch('/settings', async (c) => {
  const patch = parseOr400(
    z.object({ preferredProvider: z.enum(AI_PROVIDERS as [AiProvider, ...AiProvider[]]).nullable().optional() }).strict(),
    await c.req.json(),
  );
  return c.json({ settings: await repo.saveSettings(c.get('user').id, patch) });
});

aiRoutes.get('/usage', async (c) => {
  const { days } = parseOr400(
    z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    { days: c.req.query('days') },
  );
  return c.json(await repo.usageSummary(c.get('user').id, days));
});

// ─── OCR ─────────────────────────────────────────────────────────
// Bounds protect against memory/cost DoS: a single authenticated request
// could otherwise pin the event loop and burn the reader's own key on hundreds
// of MB of base64 images. Frontend chunks at PAGES_PER_BATCH=10
// (WordByWord/src/lib/services/book-processing-service.ts), so the array max of
// 12 leaves headroom without enabling abuse.
const OCR_MAX_IMAGES = 12;
const OCR_MAX_BASE64_PER_IMAGE = 7_000_000; // ~5.25 MB raw
const OCR_MIN_BASE64_PER_IMAGE = 100; // tiny strings always fail vision models
const OCR_MAX_TOTAL_BASE64 = 50_000_000; // ~37 MB raw across the whole request

const imageBatch = z
  .array(z.string().min(OCR_MIN_BASE64_PER_IMAGE).max(OCR_MAX_BASE64_PER_IMAGE))
  .min(1)
  .max(OCR_MAX_IMAGES)
  .refine(
    (imgs) => imgs.reduce((sum, s) => sum + s.length, 0) <= OCR_MAX_TOTAL_BASE64,
    { message: 'Total payload exceeds OCR size limit' },
  );

aiRoutes.post('/ocr', async (c) => {
  const { images } = parseOr400(z.object({ images: imageBatch }), await c.req.json());
  const texts = await runOr499(() => aiService.ocrPages(ctxOf(c), images));
  return texts === null ? new Response(null, { status: 499 }) : c.json({ texts });
});

// Split a batch of pages into study-sized sections (moved from the browser).
aiRoutes.post('/split-sections', async (c) => {
  const body = parseOr400(
    z.object({
      pageImages: imageBatch,
      pageTexts: z.array(z.string().max(20_000)).max(OCR_MAX_IMAGES).default([]),
      startPage: z.number().int().min(1),
      bookTitle: z.string().max(500).default(''),
      previousSectionTitle: z.string().max(500).nullable().default(null),
    }),
    await c.req.json(),
  );
  const result = await runOr499(() => aiService.splitSections(ctxOf(c), body));
  return result === null ? new Response(null, { status: 499 }) : c.json(result);
});

// ─── Reader-side translation / explanation ───────────────────────

const translateWordSchema = z.object({
  word: z.string().min(1).max(200),
  sentence: z.string().min(1).max(2000),
  targetLanguage: z.string().min(1).max(50),
});

aiRoutes.post('/translate-word', async (c) => {
  const b = parseOr400(translateWordSchema, await c.req.json());
  const result = await runOr499(() => aiService.translateWord(ctxOf(c), b.word, b.sentence, b.targetLanguage));
  return result === null ? new Response(null, { status: 499 }) : c.json(result);
});

const translateSentenceSchema = z.object({
  sentence: z.string().min(1).max(2000),
  paragraphContext: z.string().max(5000).optional().default(''),
  targetLanguage: z.string().min(1).max(50),
});

aiRoutes.post('/translate-sentence', async (c) => {
  const b = parseOr400(translateSentenceSchema, await c.req.json());
  const result = await runOr499(() => aiService.translateSentence(ctxOf(c), b.sentence, b.paragraphContext, b.targetLanguage));
  return result === null ? new Response(null, { status: 499 }) : c.json(result);
});

const explainTranslationSchema = z.object({
  word: z.string().min(1).max(200),
  sentence: z.string().min(1).max(2000),
  translation: z.string().min(1).max(500),
  targetLanguage: z.string().min(1).max(50),
});

aiRoutes.post('/explain-translation', async (c) => {
  const b = parseOr400(explainTranslationSchema, await c.req.json());
  const result = await runOr499(() => aiService.explainTranslation(ctxOf(c), b.word, b.sentence, b.translation, b.targetLanguage));
  return result === null ? new Response(null, { status: 499 }) : c.json(result);
});

const explainContentSchema = z.object({
  content: z.string().min(1).max(10000),
  surroundingContext: z.string().max(10000).optional().default(''),
});

aiRoutes.post('/explain-content', async (c) => {
  const b = parseOr400(explainContentSchema, await c.req.json());
  const result = await runOr499(() => aiService.explainContent(ctxOf(c), b.content, b.surroundingContext));
  return result === null ? new Response(null, { status: 499 }) : c.json(result);
});

const explainImageSchema = z.object({
  imageUrl: z.string().url().max(2000),
  surroundingContext: z.string().max(10000).optional().default(''),
});

aiRoutes.post('/explain-image', async (c) => {
  const b = parseOr400(explainImageSchema, await c.req.json());
  const result = await runOr499(() => aiService.explainImage(ctxOf(c), b.imageUrl, b.surroundingContext));
  return result === null ? new Response(null, { status: 499 }) : c.json(result);
});
