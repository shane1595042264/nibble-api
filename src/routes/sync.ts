import { Hono } from 'hono';
import { z } from 'zod';
import { syncService } from '../services/sync.service.js';
import { AppError } from '../lib/errors.js';

export const syncRoutes = new Hono();

// ─── Zod schemas ────────────────────────────────────────────────────

const syncEntitySchema = z.object({
  id: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
}).passthrough();

const syncPayloadSchema = z.object({
  lastSyncedAt: z.string(),
  changes: z.object({
    books: z.array(syncEntitySchema).default([]),
    chapters: z.array(syncEntitySchema).default([]),
    sections: z.array(syncEntitySchema).default([]),
    vocabulary: z.array(syncEntitySchema).default([]),
    settings: z.record(z.string(), z.unknown()).nullable().default(null),
    exerciseProgress: z.array(syncEntitySchema).default([]),
  }),
});

// ─── Routes ─────────────────────────────────────────────────────────

// GET /status — cloud sync status (book count, last updated, etc.)
syncRoutes.get('/status', async (c) => {
  const user = c.get('user');
  const { bookRepository } = await import('../repositories/book.repository.js');
  const { chapterRepository } = await import('../repositories/chapter.repository.js');
  const { sectionRepository } = await import('../repositories/section.repository.js');
  const { vocabularyRepository } = await import('../repositories/vocabulary.repository.js');

  const books = await bookRepository.findByUserId(user.id);
  let totalChapters = 0;
  let totalSections = 0;
  let lastUpdated: Date | null = null;

  for (const book of books) {
    const chapters = await chapterRepository.findByBookId(book.id);
    totalChapters += chapters.length;
    const sections = await sectionRepository.findByBookId(book.id);
    totalSections += sections.length;
    const bookUpdated = new Date(book.updatedAt);
    if (!lastUpdated || bookUpdated > lastUpdated) lastUpdated = bookUpdated;
  }

  const vocabCount = await vocabularyRepository.countByUserId(user.id);

  return c.json({
    books: books.map(b => ({ id: b.id, customTitle: b.customTitle, catalogId: b.catalogId, updatedAt: b.updatedAt })),
    bookCount: books.length,
    chapterCount: totalChapters,
    sectionCount: totalSections,
    vocabCount,
    lastUpdated: lastUpdated?.toISOString() ?? null,
  });
});

syncRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = syncPayloadSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const result = await syncService.sync(user.id, parsed.data);
  return c.json(result);
});
