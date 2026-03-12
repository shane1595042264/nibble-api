import { Hono } from 'hono';
import { z } from 'zod';
import { aiService } from '../services/ai.service.js';
import { AppError } from '../lib/errors.js';

export const aiRoutes = new Hono();

const wordContextSchema = z.object({
  word: z.string().min(1),
  sentence: z.string().min(1),
  bookContext: z.string().optional(),
});

const translateSchema = z.object({
  text: z.string().min(1),
  targetLanguage: z.string().min(1),
});

const explainSchema = z.object({
  text: z.string().min(1),
  bookContext: z.string().optional(),
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
