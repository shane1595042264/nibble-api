import { Hono } from 'hono';
import { z } from 'zod';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import { aiService } from '../services/ai.service.js';
import { AppError } from '../lib/errors.js';

export const aiRoutes = new Hono();

// Client-disconnect aborts surface as APIUserAbortError from the SDK or a
// DOMException with name 'AbortError' from the underlying fetch. Both mean
// the client is gone — short-circuit with 499 (client closed request) so
// the global error handler doesn't log this as an unhandled 500.
function isClientAbort(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

const wordContextSchema = z.object({
  word: z.string().min(1).max(100),
  sentence: z.string().min(1).max(2000),
  bookContext: z.string().max(5000).optional(),
});

const translateSchema = z.object({
  text: z.string().min(1).max(5000),
  targetLanguage: z.string().min(1).max(50),
});

const explainSchema = z.object({
  text: z.string().min(1).max(5000),
  bookContext: z.string().max(5000).optional(),
});

// OCR — extract text from page images using Claude Vision
// Bounds protect against memory/cost DoS: a single authenticated request
// could otherwise pin the event loop and burn the Anthropic budget on
// hundreds of MB of base64 images. Frontend chunks at PAGES_PER_BATCH=10
// (WordByWord/src/lib/services/book-processing-service.ts), so the array
// max of 12 leaves headroom without enabling abuse.
const OCR_MAX_IMAGES = 12;
const OCR_MAX_BASE64_PER_IMAGE = 7_000_000; // ~5.25 MB raw
const OCR_MIN_BASE64_PER_IMAGE = 100; // tiny strings always fail Claude Vision
const OCR_MAX_TOTAL_BASE64 = 50_000_000; // ~37 MB raw across the whole request

const ocrSchema = z.object({
  images: z
    .array(z.string().min(OCR_MIN_BASE64_PER_IMAGE).max(OCR_MAX_BASE64_PER_IMAGE))
    .min(1)
    .max(OCR_MAX_IMAGES)
    .refine(
      (imgs) => imgs.reduce((sum, s) => sum + s.length, 0) <= OCR_MAX_TOTAL_BASE64,
      { message: 'Total payload exceeds OCR size limit' }
    ),
});

aiRoutes.post('/ocr', async (c) => {
  const body = await c.req.json();
  const parsed = ocrSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  }
  const texts = await aiService.ocrPages(parsed.data.images);
  return c.json({ texts });
});

aiRoutes.post('/word-context', async (c) => {
  const body = await c.req.json();
  const parsed = wordContextSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  }
  const { word, sentence, bookContext } = parsed.data;
  const result = await aiService.wordContext(word, sentence, bookContext);
  return c.json(result);
});

aiRoutes.post('/translate', async (c) => {
  const body = await c.req.json();
  const parsed = translateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  }
  const { text, targetLanguage } = parsed.data;
  const translation = await aiService.translate(text, targetLanguage);
  return c.json({ translation });
});

aiRoutes.post('/explain', async (c) => {
  const body = await c.req.json();
  const parsed = explainSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  }
  const { text, bookContext } = parsed.data;
  const explanation = await aiService.explain(text, bookContext);
  return c.json({ explanation });
});

// ─── Reader-side translation (replaces client-side Anthropic calls) ──

const translateWordSchema = z.object({
  word: z.string().min(1).max(200),
  sentence: z.string().min(1).max(2000),
  targetLanguage: z.string().min(1).max(50),
});

aiRoutes.post('/translate-word', async (c) => {
  const body = await c.req.json();
  const parsed = translateWordSchema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  try {
    const result = await aiService.translateWord(
      parsed.data.word,
      parsed.data.sentence,
      parsed.data.targetLanguage,
      { signal: c.req.raw.signal },
    );
    return c.json(result);
  } catch (err) {
    if (isClientAbort(err)) return new Response(null, { status: 499 });
    throw err;
  }
});

const translateSentenceSchema = z.object({
  sentence: z.string().min(1).max(2000),
  paragraphContext: z.string().max(5000).optional().default(''),
  targetLanguage: z.string().min(1).max(50),
});

aiRoutes.post('/translate-sentence', async (c) => {
  const body = await c.req.json();
  const parsed = translateSentenceSchema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  try {
    const result = await aiService.translateSentence(
      parsed.data.sentence,
      parsed.data.paragraphContext,
      parsed.data.targetLanguage,
      { signal: c.req.raw.signal },
    );
    return c.json(result);
  } catch (err) {
    if (isClientAbort(err)) return new Response(null, { status: 499 });
    throw err;
  }
});

const explainTranslationSchema = z.object({
  word: z.string().min(1).max(200),
  sentence: z.string().min(1).max(2000),
  translation: z.string().min(1).max(500),
  targetLanguage: z.string().min(1).max(50),
});

aiRoutes.post('/explain-translation', async (c) => {
  const body = await c.req.json();
  const parsed = explainTranslationSchema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  try {
    const result = await aiService.explainTranslation(
      parsed.data.word,
      parsed.data.sentence,
      parsed.data.translation,
      parsed.data.targetLanguage,
      { signal: c.req.raw.signal },
    );
    return c.json(result);
  } catch (err) {
    if (isClientAbort(err)) return new Response(null, { status: 499 });
    throw err;
  }
});

const explainContentSchema = z.object({
  content: z.string().min(1).max(10000),
  surroundingContext: z.string().max(10000).optional().default(''),
});

aiRoutes.post('/explain-content', async (c) => {
  const body = await c.req.json();
  const parsed = explainContentSchema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  try {
    const result = await aiService.explainContent(
      parsed.data.content,
      parsed.data.surroundingContext,
      { signal: c.req.raw.signal },
    );
    return c.json(result);
  } catch (err) {
    if (isClientAbort(err)) return new Response(null, { status: 499 });
    throw err;
  }
});
