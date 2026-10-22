import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// PUT /books/:id/structure soft-deletes every section and re-inserts the new layout.
// Sections whose page range survives must keep their text, Mathpix content and
// reading position instead of coming back blank (KAN-352).
const bookService = vi.hoisted(() => ({ getBook: vi.fn() }));
vi.mock('../../../src/services/book.service.js', () => ({ bookService }));

const bookRepo = vi.hoisted(() => ({ findCatalogById: vi.fn(), update: vi.fn() }));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

const sectionRepo = vi.hoisted(() => ({ findByBookId: vi.fn(), softDeleteByBookId: vi.fn() }));
vi.mock('../../../src/repositories/section.repository.js', () => ({ sectionRepository: sectionRepo }));

const chapterRepo = vi.hoisted(() => ({ softDeleteByBookId: vi.fn() }));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({ chapterRepository: chapterRepo }));

// Records every bulk insert and echoes the rows back with generated ids.
const inserts = vi.hoisted(() => [] as Array<{ table: unknown; rows: Array<Record<string, unknown>> }>);
vi.mock('../../../src/db/index.js', () => {
  let n = 0;
  const tx = {
    insert: (table: unknown) => ({
      values: (rows: Array<Record<string, unknown>>) => {
        inserts.push({ table, rows });
        return { returning: async () => rows.map((r) => ({ id: `new-${++n}`, ...r })) };
      },
    }),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

const { bookRoutes } = await import('../../../src/routes/books.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');
const { sections } = await import('../../../src/db/schema.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const READ_AT = new Date('2026-01-02T03:04:05Z');

function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('/books/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/books', bookRoutes);
  return app;
}

const putStructure = (chapters: unknown) =>
  makeApp().request(`/books/${BOOK_ID}/structure`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapters }),
  });

const insertedSections = () => inserts.find((i) => i.table === sections)?.rows ?? [];

const oldSection = (id: string, startPage: number, endPage: number, extra: Record<string, unknown> = {}) => ({
  id,
  bookId: BOOK_ID,
  startPage,
  endPage,
  isRead: false,
  readAt: null,
  extractedText: `text ${id}`,
  richContent: `# rich ${id}`,
  scrollProgress: 0.4,
  lastPageViewed: endPage,
  ...extra,
});

describe('PUT /books/:id/structure', () => {
  beforeEach(() => {
    inserts.length = 0;
    vi.clearAllMocks();
    bookService.getBook.mockResolvedValue({ id: BOOK_ID, catalogId: 'cat', updatedAt: new Date() });
    bookRepo.findCatalogById.mockResolvedValue({ totalPages: 30 });
    bookRepo.update.mockResolvedValue({ updatedAt: new Date() });
    sectionRepo.findByBookId.mockResolvedValue([
      oldSection('a', 1, 10, { isRead: true, readAt: READ_AT }),
      oldSection('b', 11, 20),
      oldSection('c', 21, 30),
    ]);
  });

  it('carries text and progress onto kept ranges and leaves split pieces text-less', async () => {
    const res = await putStructure([
      { title: 'One', startPage: 1, endPage: 10 },
      {
        title: 'Two',
        startPage: 11,
        endPage: 30,
        sections: [
          { title: 'Two', startPage: 11, endPage: 20 },
          { title: 'Three a', startPage: 21, endPage: 25 },
          { title: 'Three b', startPage: 26, endPage: 30 },
        ],
      },
    ]);
    expect(res.status).toBe(200);

    // Old rows are tombstoned before the re-insert.
    expect(sectionRepo.softDeleteByBookId).toHaveBeenCalledWith(BOOK_ID, expect.anything());

    const rows = insertedSections();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      startPage: 1, endPage: 10,
      extractedText: 'text a', richContent: '# rich a',
      scrollProgress: 0.4, lastPageViewed: 10,
      isRead: true, readAt: READ_AT,
    });
    expect(rows[1]).toMatchObject({
      startPage: 11, endPage: 20,
      extractedText: 'text b', richContent: '# rich b',
      scrollProgress: 0.4, lastPageViewed: 20,
      isRead: false, readAt: null,
    });
    for (const split of rows.slice(2)) {
      expect(split).toMatchObject({
        extractedText: null, richContent: null, scrollProgress: 0, lastPageViewed: null,
      });
    }
  });

  it('hands an old row to at most one new section', async () => {
    sectionRepo.findByBookId.mockResolvedValue([oldSection('a', 1, 10)]);

    await putStructure([
      {
        title: 'One',
        startPage: 1,
        endPage: 10,
        sections: [
          { title: 'Dup 1', startPage: 1, endPage: 10 },
          { title: 'Dup 2', startPage: 1, endPage: 10 },
        ],
      },
    ]);

    const rows = insertedSections();
    expect(rows.map((r) => r.extractedText)).toEqual(['text a', null]);
  });

  // Reorganize Chapters sends chapters with no sections, so every multi-section chapter
  // is merged into one. Read coverage is summed across the old rows (KAN-362).
  describe('read state of merged sections', () => {
    const LATER = new Date('2026-03-04T05:06:07Z');
    const mergeInto = (startPage: number, endPage: number) =>
      putStructure([{ title: 'Merged', startPage, endPage }]);

    it('keeps two equal read halves read, with the latest readAt', async () => {
      sectionRepo.findByBookId.mockResolvedValue([
        oldSection('a', 1, 5, { isRead: true, readAt: READ_AT }),
        oldSection('b', 6, 10, { isRead: true, readAt: LATER }),
      ]);
      await mergeInto(1, 10);
      expect(insertedSections()[0]).toMatchObject({ isRead: true, readAt: LATER, extractedText: null });
    });

    it('keeps a chapter read when 2 of 3 equal sections are read', async () => {
      sectionRepo.findByBookId.mockResolvedValue([
        oldSection('a', 1, 3, { isRead: true, readAt: READ_AT }),
        oldSection('b', 4, 6, { isRead: true, readAt: READ_AT }),
        oldSection('c', 7, 9),
      ]);
      await mergeInto(1, 9);
      expect(insertedSections()[0]).toMatchObject({ isRead: true, readAt: READ_AT });
    });

    it('leaves a chapter unread when only 1 of 3 sections is read', async () => {
      sectionRepo.findByBookId.mockResolvedValue([
        oldSection('a', 1, 3, { isRead: true, readAt: READ_AT }),
        oldSection('b', 4, 6),
        oldSection('c', 7, 9),
      ]);
      await mergeInto(1, 9);
      expect(insertedSections()[0]).toMatchObject({ isRead: false, readAt: null });
    });

    it('does not count pages twice when old read rows overlap', async () => {
      sectionRepo.findByBookId.mockResolvedValue([
        oldSection('a', 1, 4, { isRead: true, readAt: READ_AT }),
        oldSection('b', 2, 4, { isRead: true, readAt: READ_AT }),
        oldSection('c', 3, 5, { isRead: true, readAt: READ_AT }),
        oldSection('d', 6, 10),
      ]);
      // Pages 1-5 read out of 1-10 is exactly half, so not read; summing would give 10/10.
      await mergeInto(1, 10);
      expect(insertedSections()[0]).toMatchObject({ isRead: false });
    });

    it('only counts the part of a read row inside the new range', async () => {
      sectionRepo.findByBookId.mockResolvedValue([
        oldSection('a', 1, 20, { isRead: true, readAt: READ_AT }),
        oldSection('b', 21, 30),
      ]);
      await putStructure([
        { title: 'Head', startPage: 1, endPage: 18 },
        { title: 'Tail', startPage: 19, endPage: 30 },
      ]);
      expect(insertedSections().map((r) => r.isRead)).toEqual([true, false]);
    });
  });
});
