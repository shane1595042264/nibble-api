import { describe, it, expect, vi, beforeEach } from 'vitest';

// A stale client still holding rows the server has soft-deleted (e.g. the old
// layout after PUT /books/:id/structure) pushes them back. The sync lookup used
// to hide soft-deleted rows, so each one looked brand new: the INSERT hit the
// primary key (23505), the id went into failedEntities, the client re-queued it,
// and it failed again on every sync — forever (prod: chapter 1c8c1a29 / section
// fe8dccaf, 2026-09-15 → 09-16). A tombstone must win: no write, no failure, and
// the tombstone echoed back so the client drops its ghost copy.

type Row = { id: string; deletedAt: Date | null; updatedAt: Date; [k: string]: unknown };

const pkViolation = (table: string) =>
  Object.assign(new Error(`Failed query: insert into "${table}"`), {
    cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
  });

/** In-memory table with the same soft-delete + primary-key semantics as the real repositories. */
function table(name: string) {
  const rows = new Map<string, Row>();
  return {
    rows,
    seed(row: Partial<Row> & { id: string }) {
      rows.set(row.id, { deletedAt: null, updatedAt: new Date('2026-04-01T09:17:51.000Z'), ...row } as Row);
    },
    async findByIds(ids: string[], opts?: { includeDeleted?: boolean }) {
      return ids.map((id) => rows.get(id)).filter((r): r is Row => !!r && (opts?.includeDeleted || !r.deletedAt));
    },
    create: vi.fn(async (data: Record<string, unknown>) => {
      if (rows.has(data.id as string)) throw pkViolation(name);
      const row = { deletedAt: null, ...data, updatedAt: new Date() } as Row;
      rows.set(row.id, row);
      return row;
    }),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
    softDelete: vi.fn(async (id: string) => {
      const row = rows.get(id);
      if (row) Object.assign(row, { deletedAt: new Date(), updatedAt: new Date() });
      return row ?? null;
    }),
    async findModifiedSinceForBooks(bookIds: string[], since: Date) {
      return [...rows.values()].filter((r) => bookIds.includes(r.bookId as string) && r.updatedAt >= since);
    },
    async findModifiedSince(userId: string, since: Date) {
      return [...rows.values()].filter((r) => r.userId === userId && r.updatedAt >= since);
    },
  };
}

const books = vi.hoisted(() => ({ t: null as unknown as ReturnType<typeof table> }));
const chapters = vi.hoisted(() => ({ t: null as unknown as ReturnType<typeof table> }));
const sections = vi.hoisted(() => ({ t: null as unknown as ReturnType<typeof table> }));
const vocab = vi.hoisted(() => ({ t: null as unknown as ReturnType<typeof table> }));
const forward = vi.hoisted(() => vi.fn());

vi.mock('../../../src/repositories/book.repository.js', () => ({
  bookRepository: {
    findByIds: (...a: Parameters<ReturnType<typeof table>['findByIds']>) => books.t.findByIds(...a),
    findModifiedSince: (...a: [string, Date]) => books.t.findModifiedSince(...a),
    findByUserId: async (userId: string) => [...books.t.rows.values()].filter((b) => b.userId === userId && !b.deletedAt),
    findCatalogByIds: async () => [],
    create: (d: Record<string, unknown>) => books.t.create(d),
    update: (id: string, d: Record<string, unknown>) => books.t.update(id, d),
    softDelete: (id: string) => books.t.softDelete(id),
  },
}));
vi.mock('../../../src/repositories/chapter.repository.js', () => ({
  chapterRepository: new Proxy({}, { get: (_, k) => (chapters.t as any)[k] }),
}));
vi.mock('../../../src/repositories/section.repository.js', () => ({
  sectionRepository: new Proxy({}, { get: (_, k) => (sections.t as any)[k] }),
}));
vi.mock('../../../src/repositories/vocabulary.repository.js', () => ({
  vocabularyRepository: new Proxy({}, { get: (_, k) => (vocab.t as any)[k] }),
}));
vi.mock('../../../src/repositories/settings.repository.js', () => ({
  settingsRepository: { upsert: vi.fn(), findModifiedSince: async () => null },
}));
vi.mock('../../../src/repositories/exercise.repository.js', () => ({
  exerciseRepository: { findProgressByUserId: async () => [], findProgressModifiedSince: async () => [], findByCatalogIds: async () => [] },
}));
vi.mock('../../../src/services/knowledge-base.service.js', () => ({ forwardVocabToKnowledgeBase: forward }));

const { syncService } = await import('../../../src/services/sync.service.js');

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const BOOK = '0b601a2d-0c33-4350-b915-44a5cff33058';
const OTHER_BOOK = '88888888-8888-4888-8888-888888888888';
const OLD_CHAPTER = '1c8c1a29-bdde-41e9-91f1-4caf55a81f5e';
const OLD_SECTION = 'fe8dccaf-57f5-4f6a-ad2a-9d345924acb1';
const NEW_CHAPTER = 'b936074f-4442-4f66-af02-25afc7959942';
const ORPHAN_SECTION = '77777777-7777-4777-8777-777777777777';
const DELETED_VOCAB = '66666666-6666-4666-8666-666666666666';
const FOREIGN_CHAPTER = '55555555-5555-4555-8555-555555555555';

const DELETED_AT = new Date('2026-09-14T05:11:29.257Z');
// The stale client's watermark is AFTER the delete, so an incremental pull alone
// would never carry the tombstone back to it.
const LAST_SYNCED = '2026-09-15T00:00:00.000Z';

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
const push = (changes: Partial<typeof emptyChanges>) =>
  syncService.sync(USER, { lastSyncedAt: LAST_SYNCED, changes: { ...emptyChanges, ...changes } as any });

// Exactly what the stale client sent on prod (chapterToSync / sectionToSync shape).
const staleChapter = { id: OLD_CHAPTER, bookId: BOOK, title: 'Pages 1-1', startPage: 1, endPage: 1, sortOrder: 0, updatedAt: '2026-06-17T15:52:52.805Z' };
const staleSection = {
  id: OLD_SECTION, bookId: BOOK, chapterId: OLD_CHAPTER, title: 'Page 1', startPage: 1, endPage: 1,
  isRead: true, readAt: '2026-04-01T16:02:25.124Z', lastPageViewed: 1, scrollProgress: 1, sortOrder: 1,
  sectionType: 'content', extractedText: 'text', updatedAt: '2026-07-07T14:32:42.455Z',
};

beforeEach(() => {
  books.t = table('books');
  chapters.t = table('chapters');
  sections.t = table('sections');
  vocab.t = table('vocabulary');
  forward.mockReset();

  books.t.seed({ id: BOOK, userId: USER, catalogId: 'cat', updatedAt: new Date('2026-09-14T05:18:07.073Z') });
  books.t.seed({ id: OTHER_BOOK, userId: OTHER_USER, catalogId: 'cat2' });
  chapters.t.seed({ id: OLD_CHAPTER, bookId: BOOK, title: 'Pages 1-1', deletedAt: DELETED_AT, updatedAt: DELETED_AT });
  sections.t.seed({ id: OLD_SECTION, bookId: BOOK, chapterId: OLD_CHAPTER, title: 'Page 1', isRead: true, deletedAt: DELETED_AT, updatedAt: DELETED_AT });
  chapters.t.seed({ id: NEW_CHAPTER, bookId: BOOK, title: 'Pages 1-1', updatedAt: DELETED_AT });
  vocab.t.seed({ id: DELETED_VOCAB, userId: USER, word: 'gone', deletedAt: DELETED_AT, updatedAt: DELETED_AT });
  chapters.t.seed({ id: FOREIGN_CHAPTER, bookId: OTHER_BOOK, title: 'secret', deletedAt: DELETED_AT, updatedAt: DELETED_AT });
});

describe('syncService.sync — pushed ids that are soft-deleted on the server', () => {
  it('does not fail a stale chapter/section the server has tombstoned', async () => {
    const res = await push({ chapters: [staleChapter], sections: [staleSection] });

    expect(res.failedEntities.chapters).toEqual([]);
    expect(res.failedEntities.sections).toEqual([]);
  });

  it('writes nothing — the tombstone wins and is not resurrected', async () => {
    await push({ chapters: [staleChapter], sections: [staleSection] });

    expect(chapters.t.create).not.toHaveBeenCalled();
    expect(chapters.t.update).not.toHaveBeenCalled();
    expect(sections.t.create).not.toHaveBeenCalled();
    expect(sections.t.update).not.toHaveBeenCalled();
    expect(chapters.t.rows.get(OLD_CHAPTER)?.deletedAt).toEqual(DELETED_AT);
    expect(sections.t.rows.get(OLD_SECTION)?.deletedAt).toEqual(DELETED_AT);
  });

  it('echoes the tombstones back even when they predate lastSyncedAt, so the client drops its copy', async () => {
    const res = await push({ chapters: [staleChapter], sections: [staleSection] });

    const ch = res.serverChanges.chapters.filter((c) => c.id === OLD_CHAPTER);
    const sec = res.serverChanges.sections.filter((s) => s.id === OLD_SECTION);
    expect(ch).toHaveLength(1);
    expect(ch[0].deletedAt).toBeTruthy();
    expect(sec).toHaveLength(1);
    expect(sec[0].deletedAt).toBeTruthy();
  });

  it('does not create a new section under a tombstoned chapter', async () => {
    const res = await push({
      chapters: [staleChapter],
      sections: [{ ...staleSection, id: ORPHAN_SECTION }],
    });

    expect(sections.t.create).not.toHaveBeenCalled();
    expect(res.failedEntities.sections).toEqual([]);
  });

  it('does not re-forward a tombstoned vocab word to the knowledge base, fail it, or resurrect it', async () => {
    const res = await push({
      vocabulary: [{ id: DELETED_VOCAB, word: 'gone', updatedAt: '2026-09-16T00:00:00.000Z' }] as any,
    });

    expect(forward).not.toHaveBeenCalled();
    expect(vocab.t.create).not.toHaveBeenCalled();
    expect(res.failedEntities.vocabulary).toEqual([]);
    expect(res.serverChanges.vocabulary.filter((v) => v.id === DELETED_VOCAB && v.deletedAt)).toHaveLength(1);
  });

  it("never echoes another user's tombstone, even when the client also pushes that user's book id", async () => {
    const res = await push({
      books: [{ id: OTHER_BOOK, updatedAt: '2026-09-16T00:00:00.000Z' }] as any,
      chapters: [
        { ...staleChapter, id: FOREIGN_CHAPTER, bookId: OTHER_BOOK },
        { ...staleChapter, id: FOREIGN_CHAPTER, bookId: BOOK },
      ],
      sections: [{ ...staleSection, id: FOREIGN_CHAPTER, chapterId: FOREIGN_CHAPTER }],
    });

    expect(res.serverChanges.chapters.map((c) => c.id)).not.toContain(FOREIGN_CHAPTER);
    expect(chapters.t.create).not.toHaveBeenCalled();
  });

  it('still creates a genuinely new chapter and section', async () => {
    const NEW_ID = '44444444-4444-4444-8444-444444444444';
    const NEW_SEC = '33333333-3333-4333-8333-333333333333';
    const res = await push({
      chapters: [{ ...staleChapter, id: NEW_ID }],
      sections: [{ ...staleSection, id: NEW_SEC, chapterId: NEW_ID }],
    });

    expect(chapters.t.create).toHaveBeenCalledTimes(1);
    expect(sections.t.create).toHaveBeenCalledTimes(1);
    expect(res.failedEntities).toMatchObject({ chapters: [], sections: [] });
  });
});
