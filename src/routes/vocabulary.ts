import { Hono } from 'hono';
import { z } from 'zod';
import { vocabularyRepository } from '../repositories/vocabulary.repository.js';
import { AppError, Errors } from '../lib/errors.js';

export const vocabularyRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

const createVocabSchema = z.object({
  word: z.string().min(1),
  pronunciation: z.string().optional(),
  translation: z.string().optional(),
  targetLanguage: z.string().optional(),
  definition: z.string().optional(),
  contextSentence: z.string().optional(),
  explanation: z.string().optional(),
  bookTitle: z.string().optional(),
  sectionTitle: z.string().optional(),
  page: z.coerce.number().int().optional(),
  bookId: z.string().uuid().optional(),
});

const updateVocabSchema = z.object({
  word: z.string().min(1).optional(),
  pronunciation: z.string().optional(),
  translation: z.string().optional(),
  targetLanguage: z.string().optional(),
  definition: z.string().optional(),
  contextSentence: z.string().optional(),
  explanation: z.string().optional(),
  bookTitle: z.string().optional(),
  sectionTitle: z.string().optional(),
  page: z.coerce.number().int().optional(),
  reviewCount: z.coerce.number().int().optional(),
  lastReviewedAt: z.string().datetime().optional(),
});

// ─── Routes ────────────────────────────────────────────────────────

vocabularyRoutes.get('/', async (c) => {
  const user = c.get('user');
  const bookId = c.req.query('bookId');

  if (bookId) {
    const entries = await vocabularyRepository.findByBookId(user.id, bookId);
    return c.json(entries);
  }

  const entries = await vocabularyRepository.findByUserId(user.id);
  return c.json(entries);
});

vocabularyRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const entry = await vocabularyRepository.findById(c.req.param('id'));
  if (!entry || entry.userId !== user.id) throw Errors.notFound('Vocabulary entry');
  return c.json(entry);
});

vocabularyRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createVocabSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const entry = await vocabularyRepository.create({ ...parsed.data, userId: user.id });
  return c.json(entry, 201);
});

vocabularyRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const existing = await vocabularyRepository.findById(c.req.param('id'));
  if (!existing || existing.userId !== user.id) throw Errors.notFound('Vocabulary entry');

  const body = await c.req.json();
  const parsed = updateVocabSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }

  // Convert lastReviewedAt string to Date if present
  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.lastReviewedAt) {
    data.lastReviewedAt = new Date(parsed.data.lastReviewedAt);
  }

  const entry = await vocabularyRepository.update(c.req.param('id'), data);
  return c.json(entry);
});

vocabularyRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const existing = await vocabularyRepository.findById(c.req.param('id'));
  if (!existing || existing.userId !== user.id) throw Errors.notFound('Vocabulary entry');
  const entry = await vocabularyRepository.softDelete(c.req.param('id'));
  return c.json(entry);
});
