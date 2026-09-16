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

async function push(changes: { chapters?: unknown[]; sections?: unknown[] }) {
  const res = await makeApp().request('/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lastSyncedAt: '1970-01-01T00:00:00.000Z',
      changes: { books: [], vocabulary: [], exerciseProgress: [], settings: null, chapters: [], sections: [], ...changes },
    }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ failedEntities: { chapters: string[]; sections: string[] } }>;
}

const pushedToService = () => syncServiceMock.sync.mock.calls[0][1].changes as {
  chapters: Array<{ id: string }>;
  sections: Array<{ id: string }>;
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
