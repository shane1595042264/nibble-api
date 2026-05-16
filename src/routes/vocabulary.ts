import { Hono } from 'hono';
import { z } from 'zod';
import { vocabularyRepository } from '../repositories/vocabulary.repository.js';
import { bookService } from '../services/book.service.js';
import { AppError, Errors } from '../lib/errors.js';
import {
  forwardVocabToKnowledgeBase,
  knowledgeEntryToLegacyVocab,
} from '../services/knowledge-base.service.js';

export const vocabularyRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

const createVocabSchema = z.object({
  word: z.string().min(1).max(200),
  pronunciation: z.string().max(500).optional(),
  translation: z.string().max(1000).optional(),
  targetLanguage: z.string().max(50).optional(),
  definition: z.string().max(2000).optional(),
  contextSentence: z.string().max(2000).optional(),
  explanation: z.string().max(5000).optional(),
  bookTitle: z.string().max(500).optional(),
  sectionTitle: z.string().max(500).optional(),
  page: z.coerce.number().int().min(1).optional(),
  bookId: z.string().uuid().optional(),
});

const updateVocabSchema = z.object({
  word: z.string().min(1).max(200).optional(),
  pronunciation: z.string().max(500).optional(),
  translation: z.string().max(1000).optional(),
  targetLanguage: z.string().max(50).optional(),
  definition: z.string().max(2000).optional(),
  contextSentence: z.string().max(2000).optional(),
  explanation: z.string().max(5000).optional(),
  bookTitle: z.string().max(500).optional(),
  sectionTitle: z.string().max(500).optional(),
  page: z.coerce.number().int().min(1).optional(),
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
  if (parsed.data.bookId) {
    // Still validate the book belongs to the user — protects against captures
    // for books they don't own even though we no longer store the FK locally.
    await bookService.getBook(parsed.data.bookId, user.id);
  }

  // 2026-05-16: the personal-website knowledge base is the sole source of
  // truth for vocab. We forward the entry up there and return its response
  // shaped like the legacy nibble-api response so the WordByWord sync layer
  // doesn't need to know about the migration.
  const knowledgeEntry = await forwardVocabToKnowledgeBase(parsed.data);
  return c.json(knowledgeEntryToLegacyVocab(knowledgeEntry, parsed.data), 201);
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
