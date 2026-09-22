import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// The per-entity bounds pre-filter in POST /sync must accept every value the
// server itself stores and hands back in serverChanges. A fresh device downloads
// the library and its next init sync pushes every row straight back; a row the
// filter rejects is re-queued by the client and rejected again on every sync,
// so its reading progress never reaches the cloud. sections.extracted_text and
// the chapter/section start_page/end_page columns are nullable — PUT
// /books/:id/structure inserts sections with no extractedText at all.
const syncServiceMock = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock('../../../src/services/sync.service.js', () => ({ syncService: syncServiceMock }));

const { syncRoutes } = await import('../../../src/routes/sync.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_ID = '33333333-3333-4333-8333-333333333333';
const SECTION_ID = '44444444-4444-4444-8444-444444444444';
const VOCAB_ID = '55555555-5555-4555-8555-555555555555';

function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('/sync/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/sync', syncRoutes);
  return app;
}

// Exactly the shape WordByWord's chapterToSync / sectionToSync put on the wire.
const chapter = (overrides: Record<string, unknown> = {}) => ({
  id: CHAPTER_ID,
  bookId: BOOK_ID,
  title: 'Chapter 1',
  startPage: 1,
  endPage: 12,
  sortOrder: 0,
  updatedAt: '2026-09-16T15:41:45.000Z',
  ...overrides,
});

const section = (overrides: Record<string, unknown> = {}) => ({
  id: SECTION_ID,
  bookId: BOOK_ID,
  chapterId: CHAPTER_ID,
  title: 'Section 1',
  startPage: 1,
  endPage: 4,
  isRead: true,
  readAt: '2026-09-16T15:45:00.000Z',
  lastPageViewed: null,
  scrollProgress: 0.5,
  sortOrder: 1,
  sectionType: 'content',
  extractedText: 'some text',
  updatedAt: '2026-09-16T15:41:45.000Z',
  ...overrides,
});

// Exactly the shape WordByWord's bookToSync puts on the wire (sync-service.ts).
const book = (overrides: Record<string, unknown> = {}) => ({
  id: BOOK_ID,
  customTitle: 'A Book',
  lastReadAt: '2026-09-16T15:45:00.000Z',
  lastAccessedSectionId: SECTION_ID,
  lastAccessedScrollProgress: 0.42,
  lastAccessedWordIndex: 120,
  updatedAt: '2026-09-16T15:41:45.000Z',
  ...overrides,
});

const vocab = (overrides: Record<string, unknown> = {}) => ({
  id: VOCAB_ID,
  bookId: BOOK_ID,
  word: 'ephemeral',
  pronunciation: 'ih-FEM-er-uhl',
  translation: 'fugaz',
  targetLanguage: 'es',
  definition: 'lasting for a very short time',
  contextSentence: 'An ephemeral moment.',
  explanation: 'From Greek ephemeros.',
  bookTitle: 'A Book',
  sectionTitle: 'Section 1',
  page: 12,
  updatedAt: '2026-09-16T15:41:45.000Z',
  ...overrides,
});

async function push(changes: {
  books?: unknown[];
  chapters?: unknown[];
  sections?: unknown[];
  vocabulary?: unknown[];
}) {
  const res = await makeApp().request('/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lastSyncedAt: '1970-01-01T00:00:00.000Z',
      changes: { books: [], vocabulary: [], exerciseProgress: [], settings: null, chapters: [], sections: [], ...changes },
    }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    failedEntities: { books: string[]; chapters: string[]; sections: string[]; vocabulary: string[] };
  }>;
}

const pushedToService = () => syncServiceMock.sync.mock.calls[0][1].changes as {
  books: Array<{ id: string }>;
  chapters: Array<{ id: string }>;
  sections: Array<{ id: string }>;
  vocabulary: Array<{ id: string }>;
};

beforeEach(() => {
  vi.clearAllMocks();
  syncServiceMock.sync.mockResolvedValue({
    serverChanges: { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [], exercises: [] },
    failedEntities: { books: [], chapters: [], sections: [], vocabulary: [], exerciseProgress: [] },
    syncedAt: '2026-09-16T15:51:48.000Z',
  });
});

describe('POST /sync bounds pre-filter — round-trips the server’s own nullable columns', () => {
  it('passes a section whose extractedText is null (a Reorganize-saved section)', async () => {
    const body = await push({ sections: [section({ extractedText: null })] });

    expect(body.failedEntities.sections).toEqual([]);
    expect(pushedToService().sections.map((s) => s.id)).toEqual([SECTION_ID]);
  });

  it('passes a section whose richContent is null', async () => {
    const body = await push({ sections: [section({ richContent: null })] });

    expect(body.failedEntities.sections).toEqual([]);
  });

  it('passes a section with null start/end pages', async () => {
    const body = await push({ sections: [section({ startPage: null, endPage: null })] });

    expect(body.failedEntities.sections).toEqual([]);
    expect(pushedToService().sections.map((s) => s.id)).toEqual([SECTION_ID]);
  });

  it('passes a chapter with null start/end pages', async () => {
    const body = await push({ chapters: [chapter({ startPage: null, endPage: null })] });

    expect(body.failedEntities.chapters).toEqual([]);
    expect(pushedToService().chapters.map((c) => c.id)).toEqual([CHAPTER_ID]);
  });

  it('passes a range with only one bound set', async () => {
    const body = await push({
      chapters: [chapter({ startPage: 3, endPage: null })],
      sections: [section({ startPage: null, endPage: 7 })],
    });

    expect(body.failedEntities).toMatchObject({ chapters: [], sections: [] });
  });

  it('does not coerce a null page into a stored value', async () => {
    await push({ sections: [section({ startPage: null, endPage: null })] });

    expect(pushedToService().sections[0]).toMatchObject({ startPage: null, endPage: null });
  });

  it('still rejects a genuinely out-of-bounds row', async () => {
    const body = await push({
      chapters: [chapter({ startPage: 0, endPage: 5 })],
      sections: [section({ startPage: 9, endPage: 2 })],
    });

    expect(body.failedEntities).toMatchObject({ chapters: [CHAPTER_ID], sections: [SECTION_ID] });
    expect(pushedToService()).toMatchObject({ chapters: [], sections: [] });
  });
});

describe('POST /sync bounds pre-filter — vocabulary (KAN-320)', () => {
  it('rejects an over-cap word and explanation before the payload reaches the sync service', async () => {
    // The knowledge-base fan-out lives inside syncService.sync and is
    // append-only (no DELETE, no PATCH), so an entry that never reaches the
    // service can never reach the KB. Asserting the id is absent from the
    // service call IS the proof that the irreversible POST was skipped.
    const body = await push({
      vocabulary: [vocab({ word: 'x'.repeat(201), explanation: 'y'.repeat(5001) })],
    });

    expect(body.failedEntities.vocabulary).toEqual([VOCAB_ID]);
    expect(pushedToService().vocabulary).toEqual([]);
  });

  it.each([
    ['word', 201],
    ['pronunciation', 501],
    ['translation', 1001],
    ['targetLanguage', 51],
    ['definition', 2001],
    ['contextSentence', 2001],
    ['explanation', 5001],
    ['bookTitle', 501],
    ['sectionTitle', 501],
  ])('rejects vocabulary whose %s exceeds the REST cap', async (field, len) => {
    const body = await push({ vocabulary: [vocab({ [field]: 'z'.repeat(len) })] });

    expect(body.failedEntities.vocabulary).toEqual([VOCAB_ID]);
    expect(pushedToService().vocabulary).toEqual([]);
  });

  it('passes a vocabulary row sitting exactly on every cap', async () => {
    const body = await push({
      vocabulary: [vocab({ word: 'a'.repeat(200), explanation: 'b'.repeat(5000) })],
    });

    expect(body.failedEntities.vocabulary).toEqual([]);
    expect(pushedToService().vocabulary.map((v) => v.id)).toEqual([VOCAB_ID]);
  });

  it('passes a vocabulary row whose nullable text columns are all null', async () => {
    const body = await push({
      vocabulary: [
        vocab({
          pronunciation: null,
          translation: null,
          targetLanguage: null,
          definition: null,
          contextSentence: null,
          explanation: null,
          bookTitle: null,
          sectionTitle: null,
          page: null,
        }),
      ],
    });

    expect(body.failedEntities.vocabulary).toEqual([]);
    expect(pushedToService().vocabulary.map((v) => v.id)).toEqual([VOCAB_ID]);
  });

  it('passes a page of 0 — prod holds such a row and a min(1) bound would re-queue it forever', async () => {
    const body = await push({ vocabulary: [vocab({ page: 0 })] });

    expect(body.failedEntities.vocabulary).toEqual([]);
    expect(pushedToService().vocabulary.map((v) => v.id)).toEqual([VOCAB_ID]);
  });

  it('rejects only the offending row and lets its siblings through', async () => {
    const OTHER = '66666666-6666-4666-8666-666666666666';
    const body = await push({
      vocabulary: [vocab({ explanation: 'q'.repeat(9999) }), vocab({ id: OTHER })],
    });

    expect(body.failedEntities.vocabulary).toEqual([VOCAB_ID]);
    expect(pushedToService().vocabulary.map((v) => v.id)).toEqual([OTHER]);
  });
});

describe('POST /sync bounds pre-filter — books (KAN-320)', () => {
  it('rejects lastAccessedScrollProgress sent in 0-100 units (the KAN-114 unit bug)', async () => {
    const body = await push({ books: [book({ lastAccessedScrollProgress: 85 })] });

    expect(body.failedEntities.books).toEqual([BOOK_ID]);
    expect(pushedToService().books).toEqual([]);
  });

  it('rejects a negative lastAccessedScrollProgress', async () => {
    const body = await push({ books: [book({ lastAccessedScrollProgress: -0.5 })] });

    expect(body.failedEntities.books).toEqual([BOOK_ID]);
  });

  it('rejects an over-cap customTitle and coverUrl', async () => {
    expect((await push({ books: [book({ customTitle: 'x'.repeat(501) })] })).failedEntities.books)
      .toEqual([BOOK_ID]);

    vi.clearAllMocks();
    syncServiceMock.sync.mockResolvedValue({
      serverChanges: { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [], exercises: [] },
      failedEntities: { books: [], chapters: [], sections: [], vocabulary: [], exerciseProgress: [] },
      syncedAt: '2026-09-16T15:51:48.000Z',
    });

    expect((await push({ books: [book({ coverUrl: 'data:image/png;base64,' + 'A'.repeat(2100) })] })).failedEntities.books)
      .toEqual([BOOK_ID]);
  });

  it('passes the exact payload WordByWord.bookToSync builds', async () => {
    const body = await push({ books: [book()] });

    expect(body.failedEntities.books).toEqual([]);
    expect(pushedToService().books.map((b) => b.id)).toEqual([BOOK_ID]);
  });

  it('passes the 0 and 1 endpoints of the progress range', async () => {
    expect((await push({ books: [book({ lastAccessedScrollProgress: 0 })] })).failedEntities.books).toEqual([]);

    vi.clearAllMocks();
    syncServiceMock.sync.mockResolvedValue({
      serverChanges: { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [], exercises: [] },
      failedEntities: { books: [], chapters: [], sections: [], vocabulary: [], exerciseProgress: [] },
      syncedAt: '2026-09-16T15:51:48.000Z',
    });

    expect((await push({ books: [book({ lastAccessedScrollProgress: 1 })] })).failedEntities.books).toEqual([]);
  });

  it('passes a book whose nullable progress columns are all null', async () => {
    const body = await push({
      books: [
        book({
          customTitle: null,
          lastReadAt: null,
          lastAccessedSectionId: null,
          lastAccessedScrollProgress: null,
          lastAccessedWordIndex: null,
        }),
      ],
    });

    expect(body.failedEntities.books).toEqual([]);
    expect(pushedToService().books.map((b) => b.id)).toEqual([BOOK_ID]);
  });
});

describe('POST /sync bounds pre-filter — full server echo round-trips clean (KAN-320)', () => {
  it('accepts a payload of the server’s own rows across all four entity arrays', async () => {
    // The re-queue-forever trap: a fresh device downloads the library and its
    // init sync pushes every downloaded row straight back. Anything the filter
    // rejects here is rejected on every sync for the life of the device.
    const body = await push({
      books: [book({ customTitle: null, lastAccessedScrollProgress: null, lastAccessedWordIndex: null })],
      chapters: [chapter({ startPage: null, endPage: null })],
      sections: [section({ extractedText: null, richContent: null, startPage: null, endPage: null })],
      vocabulary: [vocab({ explanation: null, page: 0 })],
    });

    expect(body.failedEntities).toMatchObject({
      books: [], chapters: [], sections: [], vocabulary: [],
    });
  });
});
