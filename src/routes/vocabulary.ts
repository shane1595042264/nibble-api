import { Hono } from 'hono';
import { z } from 'zod';
import { vocabularyRepository } from '../repositories/vocabulary.repository.js';
import { bookService } from '../services/book.service.js';
import { AppError, Errors } from '../lib/errors.js';
import { assertUuidQueryParam, assertUuidPathParam } from '../lib/query-guards.js';

export const vocabularyRoutes = new Hono();

// ─── Field limits ──────────────────────────────────────────────────

// Exported so POST /sync can bound the same columns with the same numbers
// instead of duplicating literals that would silently drift apart.
// Precedent: SECTION_TITLE_MAX & co. in sections.ts, imported by sync.ts.
export const VOCAB_WORD_MAX = 200;
export const VOCAB_PRONUNCIATION_MAX = 500;
export const VOCAB_TRANSLATION_MAX = 1000;
export const VOCAB_TARGET_LANGUAGE_MAX = 50;
export const VOCAB_DEFINITION_MAX = 2000;
export const VOCAB_CONTEXT_SENTENCE_MAX = 2000;
export const VOCAB_EXPLANATION_MAX = 5000;
export const VOCAB_BOOK_TITLE_MAX = 500;
export const VOCAB_SECTION_TITLE_MAX = 500;

// ─── Zod schemas ───────────────────────────────────────────────────

const createVocabSchema = z.object({
  word: z.string().min(1).max(VOCAB_WORD_MAX),
  pronunciation: z.string().max(VOCAB_PRONUNCIATION_MAX).optional(),
  translation: z.string().max(VOCAB_TRANSLATION_MAX).optional(),
  targetLanguage: z.string().max(VOCAB_TARGET_LANGUAGE_MAX).optional(),
  definition: z.string().max(VOCAB_DEFINITION_MAX).optional(),
  contextSentence: z.string().max(VOCAB_CONTEXT_SENTENCE_MAX).optional(),
  explanation: z.string().max(VOCAB_EXPLANATION_MAX).optional(),
  bookTitle: z.string().max(VOCAB_BOOK_TITLE_MAX).optional(),
  sectionTitle: z.string().max(VOCAB_SECTION_TITLE_MAX).optional(),
  page: z.coerce.number().int().min(1).optional(),
  bookId: z.string().uuid().optional(),
});

const updateVocabSchema = z.object({
  word: z.string().min(1).max(VOCAB_WORD_MAX).optional(),
  pronunciation: z.string().max(VOCAB_PRONUNCIATION_MAX).optional(),
  translation: z.string().max(VOCAB_TRANSLATION_MAX).optional(),
  targetLanguage: z.string().max(VOCAB_TARGET_LANGUAGE_MAX).optional(),
  definition: z.string().max(VOCAB_DEFINITION_MAX).optional(),
  contextSentence: z.string().max(VOCAB_CONTEXT_SENTENCE_MAX).optional(),
  explanation: z.string().max(VOCAB_EXPLANATION_MAX).optional(),
  bookTitle: z.string().max(VOCAB_BOOK_TITLE_MAX).optional(),
  sectionTitle: z.string().max(VOCAB_SECTION_TITLE_MAX).optional(),
  page: z.coerce.number().int().min(1).optional(),
  reviewCount: z.coerce.number().int().optional(),
  lastReviewedAt: z.string().datetime().optional(),
});

// ─── Routes ────────────────────────────────────────────────────────

vocabularyRoutes.get('/', async (c) => {
  const user = c.get('user');
  const bookId = c.req.query('bookId');

  if (bookId) {
    assertUuidQueryParam(bookId, 'bookId');
    const entries = await vocabularyRepository.findByBookId(user.id, bookId);
    return c.json(entries);
  }

  const entries = await vocabularyRepository.findByUserId(user.id);
  return c.json(entries);
});

vocabularyRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = assertUuidPathParam(c.req.param('id'), 'id');
  const entry = await vocabularyRepository.findById(id);
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
  if (parsed.data.bookId) {
    await bookService.getBook(parsed.data.bookId, user.id);
  }
  const entry = await vocabularyRepository.create({ ...parsed.data, userId: user.id });
  return c.json(entry, 201);
});

vocabularyRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const id = assertUuidPathParam(c.req.param('id'), 'id');
  const existing = await vocabularyRepository.findById(id);
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

  const entry = await vocabularyRepository.update(id, data);
  return c.json(entry);
});

vocabularyRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = assertUuidPathParam(c.req.param('id'), 'id');
  const existing = await vocabularyRepository.findById(id);
  if (!existing || existing.userId !== user.id) throw Errors.notFound('Vocabulary entry');
  const entry = await vocabularyRepository.softDelete(id);
  return c.json(entry);
});
