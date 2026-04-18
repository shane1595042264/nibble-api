import { Hono } from 'hono';
import { z } from 'zod';
import { aiService } from '../services/ai.service.js';
import { AppError } from '../lib/errors.js';

export const aiRoutes = new Hono();

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
aiRoutes.post('/ocr', async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    images: z.array(z.string().min(1)),
  });
  const parsed = schema.safeParse(body);
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
  const result = await aiService.translateWord(parsed.data.word, parsed.data.sentence, parsed.data.targetLanguage);
  return c.json(result);
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
  const result = await aiService.translateSentence(parsed.data.sentence, parsed.data.paragraphContext, parsed.data.targetLanguage);
  return c.json(result);
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
  const result = await aiService.explainTranslation(parsed.data.word, parsed.data.sentence, parsed.data.translation, parsed.data.targetLanguage);
  return c.json(result);
});

const explainContentSchema = z.object({
  content: z.string().min(1).max(10000),
  surroundingContext: z.string().max(10000).optional().default(''),
});

aiRoutes.post('/explain-content', async (c) => {
  const body = await c.req.json();
  const parsed = explainContentSchema.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid request body', 400);
  const result = await aiService.explainContent(parsed.data.content, parsed.data.surroundingContext);
  return c.json(result);
});
