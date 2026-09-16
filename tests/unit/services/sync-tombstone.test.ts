import { describe, it, expect, beforeEach } from 'vitest';
import { db, forward, loadSyncService, resetDb } from './sync-harness.js';

// A stale client still holding rows the server has soft-deleted (e.g. the old
// layout after PUT /books/:id/structure) pushes them back. The sync lookup used
// to hide soft-deleted rows, so each one looked brand new: the INSERT hit the
// primary key (23505), the id went into failedEntities, the client re-queued it,
// and it failed again on every sync — forever (prod: chapter 1c8c1a29 / section
// fe8dccaf, 2026-09-15 → 09-16). A tombstone must win: no write, no failure, and
// the tombstone echoed back so the client drops its ghost copy.

const syncService = await loadSyncService();

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
  resetDb();

  db.books.seed({ id: BOOK, userId: USER, catalogId: 'cat', updatedAt: new Date('2026-09-14T05:18:07.073Z') });
  db.books.seed({ id: OTHER_BOOK, userId: OTHER_USER, catalogId: 'cat2' });
  db.chapters.seed({ id: OLD_CHAPTER, bookId: BOOK, title: 'Pages 1-1', deletedAt: DELETED_AT, updatedAt: DELETED_AT });
  db.sections.seed({ id: OLD_SECTION, bookId: BOOK, chapterId: OLD_CHAPTER, title: 'Page 1', isRead: true, deletedAt: DELETED_AT, updatedAt: DELETED_AT });
  db.chapters.seed({ id: NEW_CHAPTER, bookId: BOOK, title: 'Pages 1-1', updatedAt: DELETED_AT });
  db.vocab.seed({ id: DELETED_VOCAB, userId: USER, word: 'gone', deletedAt: DELETED_AT, updatedAt: DELETED_AT });
  db.chapters.seed({ id: FOREIGN_CHAPTER, bookId: OTHER_BOOK, title: 'secret', deletedAt: DELETED_AT, updatedAt: DELETED_AT });
});

describe('syncService.sync — pushed ids that are soft-deleted on the server', () => {
  it('does not fail a stale chapter/section the server has tombstoned', async () => {
    const res = await push({ chapters: [staleChapter], sections: [staleSection] });

    expect(res.failedEntities.chapters).toEqual([]);
    expect(res.failedEntities.sections).toEqual([]);
  });

  it('writes nothing — the tombstone wins and is not resurrected', async () => {
    await push({ chapters: [staleChapter], sections: [staleSection] });

    expect(db.chapters.create).not.toHaveBeenCalled();
    expect(db.chapters.update).not.toHaveBeenCalled();
    expect(db.sections.create).not.toHaveBeenCalled();
    expect(db.sections.update).not.toHaveBeenCalled();
    expect(db.chapters.rows.get(OLD_CHAPTER)?.deletedAt).toEqual(DELETED_AT);
    expect(db.sections.rows.get(OLD_SECTION)?.deletedAt).toEqual(DELETED_AT);
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

    expect(db.sections.create).not.toHaveBeenCalled();
    expect(res.failedEntities.sections).toEqual([]);
  });

  it('does not re-forward a tombstoned vocab word to the knowledge base, fail it, or resurrect it', async () => {
    const res = await push({
      vocabulary: [{ id: DELETED_VOCAB, word: 'gone', updatedAt: '2026-09-16T00:00:00.000Z' }] as any,
    });

    expect(forward).not.toHaveBeenCalled();
    expect(db.vocab.create).not.toHaveBeenCalled();
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
    expect(db.chapters.create).not.toHaveBeenCalled();
  });

  it('still creates a genuinely new chapter and section', async () => {
    const NEW_ID = '44444444-4444-4444-8444-444444444444';
    const NEW_SEC = '33333333-3333-4333-8333-333333333333';
    const res = await push({
      chapters: [{ ...staleChapter, id: NEW_ID }],
      sections: [{ ...staleSection, id: NEW_SEC, chapterId: NEW_ID }],
    });

    expect(db.chapters.create).toHaveBeenCalledTimes(1);
    expect(db.sections.create).toHaveBeenCalledTimes(1);
    expect(res.failedEntities).toMatchObject({ chapters: [], sections: [] });
  });
});
