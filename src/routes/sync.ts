import { Hono } from 'hono';
import { z } from 'zod';
import { syncService } from '../services/sync.service.js';
import { AppError } from '../lib/errors.js';
import { VIEW_MODES, READING_MODES, TRACKING_MODES } from './settings.js';

export const syncRoutes = new Hono();

// ─── Zod schemas ────────────────────────────────────────────────────

const syncEntitySchema = z.object({
  id: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
}).passthrough();

// scrollProgress must match the [0, 1] contract enforced by PUT /api/sections/:id —
// the Max-wins conflict resolver makes any bad value sticky once it lands.
const syncSectionSchema = z.object({
  id: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
  scrollProgress: z.number().min(0).max(1).optional(),
}).passthrough();

// Lenient settings: invalid enum/range values are silently dropped via .catch(undefined)
// so a stale or buggy client can't permanently wedge sync. Unknown keys pass through
// (passthrough) — the repository only writes columns known to Drizzle.
const syncSettingsSchema = z.object({
  autoReadThresholdSeconds: z.coerce.number().int().min(1).max(3600).optional().catch(undefined),
  defaultViewMode: z.enum(VIEW_MODES).optional().catch(undefined),
  readingMode: z.enum(READING_MODES).optional().catch(undefined),
  trackingMode: z.enum(TRACKING_MODES).optional().catch(undefined),
  targetLanguage: z.string().optional().catch(undefined),
  keymapOverrides: z.record(z.string(), z.unknown()).optional().catch(undefined),
}).passthrough();

const syncPayloadSchema = z.object({
  lastSyncedAt: z.string(),
  changes: z.object({
    books: z.array(syncEntitySchema).default([]),
    chapters: z.array(syncEntitySchema).default([]),
    sections: z.array(syncSectionSchema).default([]),
    vocabulary: z.array(syncEntitySchema).default([]),
    settings: syncSettingsSchema.nullable().default(null),
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
  const bookIds = books.map(b => b.id);

  const [chapterCounts, sectionCounts, vocabCount] = await Promise.all([
    chapterRepository.countByBookIds(bookIds),
    sectionRepository.countByBookIds(bookIds),
    vocabularyRepository.countByUserId(user.id),
  ]);

  let totalChapters = 0;
  let totalSections = 0;
  let lastUpdated: Date | null = null;

  for (const book of books) {
    totalChapters += chapterCounts.get(book.id) ?? 0;
    totalSections += sectionCounts.get(book.id) ?? 0;
    const bookUpdated = new Date(book.updatedAt);
    if (!lastUpdated || bookUpdated > lastUpdated) lastUpdated = bookUpdated;
  }

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
