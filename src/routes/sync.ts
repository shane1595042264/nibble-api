import { Hono } from 'hono';
import { z } from 'zod';
import { syncService } from '../services/sync.service.js';
import { AppError } from '../lib/errors.js';
import { VIEW_MODES, READING_MODES, TRACKING_MODES } from './settings.js';
import { SECTION_TITLE_MAX, SECTION_TYPE_MAX, SECTION_EXTRACTED_TEXT_MAX } from './sections.js';

export const syncRoutes = new Hono();

// ~2MB — matches extractedText. richContent (Mathpix Markdown) is the same shape of payload.
const SECTION_RICH_CONTENT_MAX = 2_000_000;
const CHAPTER_TITLE_MAX = 500;

// Array-count caps on the sync payload. A first-ever full sync of a large library
// is the legitimate upper bound; anything past these is a malformed/abusive payload.
// Unlike per-entity field-bounds violations (which route to failedEntities to
// preserve the client's dirty-flag bookkeeping), an array-count overflow is a
// structural violation and fails the WHOLE request with 400 via the existing
// safeParse guard in the route. Sized well above any realistic library yet far
// below a DoS payload. vocabulary is capped lower because every NEW vocab entry
// fans out one external POST to shanejli's knowledge base (sync.service.ts).
export const MAX_SYNC_BOOKS = 5_000;
export const MAX_SYNC_CHAPTERS = 20_000;
export const MAX_SYNC_SECTIONS = 20_000;
export const MAX_SYNC_VOCABULARY = 10_000;
export const MAX_SYNC_EXERCISE_PROGRESS = 20_000;

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

// Strict field-bounds schemas applied per-entity in the route. A violation pushes
// the id into failedEntities (NOT a 400 on the whole payload), so the client
// re-bumps updatedAt and the rest of the sync still goes through.
// Page ranges mirror the REST contract in chapters.ts / sections.ts: positive
// ints and startPage <= endPage. .passthrough() is kept so unknown forward-compat
// fields still flow; .refine sits after passthrough to gate the cross-field rule.
export const chapterBoundsSchema = z
  .object({
    title: z.string().max(CHAPTER_TITLE_MAX).optional(),
    startPage: z.coerce.number().int().positive().optional(),
    endPage: z.coerce.number().int().positive().optional(),
  })
  .passthrough()
  .refine(
    (data) =>
      data.startPage === undefined ||
      data.endPage === undefined ||
      data.startPage <= data.endPage,
    { message: 'Chapter startPage must be <= endPage' },
  );

export const sectionBoundsSchema = z
  .object({
    title: z.string().max(SECTION_TITLE_MAX).optional(),
    sectionType: z.string().max(SECTION_TYPE_MAX).optional(),
    extractedText: z.string().max(SECTION_EXTRACTED_TEXT_MAX).optional(),
    richContent: z.string().max(SECTION_RICH_CONTENT_MAX).optional(),
    startPage: z.coerce.number().int().positive().optional(),
    endPage: z.coerce.number().int().positive().optional(),
  })
  .passthrough()
  .refine(
    (data) =>
      data.startPage === undefined ||
      data.endPage === undefined ||
      data.startPage <= data.endPage,
    { message: 'Section startPage must be <= endPage' },
  );

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

export const syncPayloadSchema = z.object({
  lastSyncedAt: z.string(),
  changes: z.object({
    books: z.array(syncEntitySchema).max(MAX_SYNC_BOOKS).default([]),
    chapters: z.array(syncEntitySchema).max(MAX_SYNC_CHAPTERS).default([]),
    sections: z.array(syncSectionSchema).max(MAX_SYNC_SECTIONS).default([]),
    vocabulary: z.array(syncEntitySchema).max(MAX_SYNC_VOCABULARY).default([]),
    settings: syncSettingsSchema.nullable().default(null),
    exerciseProgress: z.array(syncEntitySchema).max(MAX_SYNC_EXERCISE_PROGRESS).default([]),
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

  // Pre-filter chapters/sections against strict field-length bounds. Invalid
  // entries are dropped from the payload and their ids are surfaced via
  // failedEntities so the client retries on the next tick (matches the
  // existing sync contract — see sync.service.ts L155).
  const preFilterFailed = { chapters: [] as string[], sections: [] as string[] };
  const filteredChapters = parsed.data.changes.chapters.filter((ch) => {
    if (chapterBoundsSchema.safeParse(ch).success) return true;
    preFilterFailed.chapters.push(ch.id);
    return false;
  });
  const filteredSections = parsed.data.changes.sections.filter((sec) => {
    if (sectionBoundsSchema.safeParse(sec).success) return true;
    preFilterFailed.sections.push(sec.id);
    return false;
  });

  const cleanedPayload = {
    ...parsed.data,
    changes: {
      ...parsed.data.changes,
      chapters: filteredChapters,
      sections: filteredSections,
    },
  };

  const result = await syncService.sync(user.id, cleanedPayload);
  return c.json({
    ...result,
    failedEntities: {
      ...result.failedEntities,
      chapters: [...result.failedEntities.chapters, ...preFilterFailed.chapters],
      sections: [...result.failedEntities.sections, ...preFilterFailed.sections],
    },
  });
});
