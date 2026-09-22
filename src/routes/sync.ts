import { Hono } from 'hono';
import { z } from 'zod';
import { syncService } from '../services/sync.service.js';
import { AppError } from '../lib/errors.js';
import { VIEW_MODES, READING_MODES, TRACKING_MODES } from './settings.js';
import { SECTION_TITLE_MAX, SECTION_TYPE_MAX, SECTION_EXTRACTED_TEXT_MAX } from './sections.js';
import { BOOK_CUSTOM_TITLE_MAX, BOOK_COVER_URL_MAX } from './books.js';
import {
  VOCAB_WORD_MAX,
  VOCAB_PRONUNCIATION_MAX,
  VOCAB_TRANSLATION_MAX,
  VOCAB_TARGET_LANGUAGE_MAX,
  VOCAB_DEFINITION_MAX,
  VOCAB_CONTEXT_SENTENCE_MAX,
  VOCAB_EXPLANATION_MAX,
  VOCAB_BOOK_TITLE_MAX,
  VOCAB_SECTION_TITLE_MAX,
} from './vocabulary.js';

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
//
// Unlike REST, sync must also accept NULL wherever the column is nullable: a
// fresh device pushes every downloaded row straight back, so a value the server
// stores and emits in serverChanges has to pass here or that row is re-queued
// and rejected on every sync forever. null is matched before the coerce because
// z.coerce.number() turns null into 0, which .positive() then rejects.
const syncPage = z.union([z.null(), z.coerce.number().int().positive()]).optional();

export const chapterBoundsSchema = z
  .object({
    title: z.string().max(CHAPTER_TITLE_MAX).optional(),
    startPage: syncPage,
    endPage: syncPage,
  })
  .passthrough()
  .refine(
    (data) =>
      data.startPage == null ||
      data.endPage == null ||
      data.startPage <= data.endPage,
    { message: 'Chapter startPage must be <= endPage' },
  );

export const sectionBoundsSchema = z
  .object({
    title: z.string().max(SECTION_TITLE_MAX).optional(),
    sectionType: z.string().max(SECTION_TYPE_MAX).optional(),
    extractedText: z.string().max(SECTION_EXTRACTED_TEXT_MAX).nullable().optional(),
    richContent: z.string().max(SECTION_RICH_CONTENT_MAX).nullable().optional(),
    startPage: syncPage,
    endPage: syncPage,
  })
  .passthrough()
  .refine(
    (data) =>
      data.startPage == null ||
      data.endPage == null ||
      data.startPage <= data.endPage,
    { message: 'Section startPage must be <= endPage' },
  );

// Books and vocabulary reach the same columns as PUT /api/books/:id and
// POST /api/vocabulary, which cap every text field and constrain
// lastAccessedScrollProgress to [0, 1]. Without these the sync path is a
// strictly weaker door onto those columns: a multi-MB string lands in Postgres
// and is echoed back to every device on the next pull, and an out-of-range
// progress corrupts Continue Reading restore (the unit bug KAN-114 fixed).
//
// Every field is .nullable() because the column is nullable and a fresh device
// pushes the server's own rows straight back — see the re-queue note above.
export const bookBoundsSchema = z
  .object({
    customTitle: z.string().max(BOOK_CUSTOM_TITLE_MAX).nullable().optional(),
    // Length only, no .url(): the cap is what bounds the blast radius (a page-1
    // PNG data: URL is megabytes), and a format check would reject any legacy
    // non-URL value the server already stores, re-queueing it forever.
    coverUrl: z.string().max(BOOK_COVER_URL_MAX).nullable().optional(),
    lastAccessedScrollProgress: z
      .union([z.null(), z.coerce.number().min(0).max(1)])
      .optional(),
    lastAccessedWordIndex: z.union([z.null(), z.coerce.number().int()]).optional(),
  })
  .passthrough();

// NEW vocab rows fan out to the append-only external knowledge base before the
// local insert (sync.service.ts) and that KB exposes no DELETE or PATCH, so an
// oversized field forwarded there is permanent. This filter runs in the route,
// before syncService.sync() is called at all, which is what keeps an over-cap
// row from ever reaching that irreversible call.
//
// Two REST constraints are deliberately NOT mirrored, both to avoid the
// re-queue-forever trap:
//  - page: REST requires .int().min(1), but prod holds a live row with page 0
//    that the server emits in serverChanges and a fresh device pushes back.
//    page is an integer column — no oversized write, no KB fan-out — so the
//    bound would buy nothing and wedge a real row.
//  - word: max is enforced, min(1) is not. word is NOT NULL but '' is a legal
//    stored value, so a minimum is the same trap class.
export const vocabBoundsSchema = z
  .object({
    word: z.string().max(VOCAB_WORD_MAX).nullable().optional(),
    pronunciation: z.string().max(VOCAB_PRONUNCIATION_MAX).nullable().optional(),
    translation: z.string().max(VOCAB_TRANSLATION_MAX).nullable().optional(),
    targetLanguage: z.string().max(VOCAB_TARGET_LANGUAGE_MAX).nullable().optional(),
    definition: z.string().max(VOCAB_DEFINITION_MAX).nullable().optional(),
    contextSentence: z.string().max(VOCAB_CONTEXT_SENTENCE_MAX).nullable().optional(),
    explanation: z.string().max(VOCAB_EXPLANATION_MAX).nullable().optional(),
    bookTitle: z.string().max(VOCAB_BOOK_TITLE_MAX).nullable().optional(),
    sectionTitle: z.string().max(VOCAB_SECTION_TITLE_MAX).nullable().optional(),
  })
  .passthrough();

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
    // exerciseProgress has no field bounds: exercise_progress is reachable
    // through sync only — there is no REST route for it — so there are no
    // limits to mirror, and inventing them here would be a new contract rather
    // than a second door onto an existing one.
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

  // Pre-filter each entity array against strict field-length bounds. Invalid
  // entries are dropped from the payload and their ids are surfaced via
  // failedEntities so the client retries on the next tick (matches the
  // existing sync contract — see sync.service.ts L155).
  //
  // This runs before syncService.sync(), which is load-bearing for vocabulary:
  // a NEW word is forwarded to the append-only external knowledge base before
  // the local insert, and that POST cannot be undone.
  const preFilterFailed = {
    books: [] as string[],
    chapters: [] as string[],
    sections: [] as string[],
    vocabulary: [] as string[],
  };
  const filterBy = <T extends { id: string }>(
    rows: T[],
    schema: { safeParse: (v: unknown) => { success: boolean } },
    failed: string[],
  ): T[] =>
    rows.filter((row) => {
      if (schema.safeParse(row).success) return true;
      failed.push(row.id);
      return false;
    });

  const filteredBooks = filterBy(parsed.data.changes.books, bookBoundsSchema, preFilterFailed.books);
  const filteredChapters = filterBy(parsed.data.changes.chapters, chapterBoundsSchema, preFilterFailed.chapters);
  const filteredSections = filterBy(parsed.data.changes.sections, sectionBoundsSchema, preFilterFailed.sections);
  const filteredVocabulary = filterBy(parsed.data.changes.vocabulary, vocabBoundsSchema, preFilterFailed.vocabulary);

  const cleanedPayload = {
    ...parsed.data,
    changes: {
      ...parsed.data.changes,
      books: filteredBooks,
      chapters: filteredChapters,
      sections: filteredSections,
      vocabulary: filteredVocabulary,
    },
  };

  const result = await syncService.sync(user.id, cleanedPayload);
  return c.json({
    ...result,
    failedEntities: {
      ...result.failedEntities,
      books: [...result.failedEntities.books, ...preFilterFailed.books],
      chapters: [...result.failedEntities.chapters, ...preFilterFailed.chapters],
      sections: [...result.failedEntities.sections, ...preFilterFailed.sections],
      vocabulary: [...result.failedEntities.vocabulary, ...preFilterFailed.vocabulary],
    },
  });
});
