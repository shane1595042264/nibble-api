import { describe, it, expect, beforeEach } from 'vitest';
import { db, loadSyncService, resetDb } from './sync-harness.js';

// existingBookIdSet gates every chapter/section/vocab write on "the parent book
// belongs to this user". After the books loop, every pushed non-deleted book id
// was added to it without an ownership check — even ids the loop had just skipped
// as another user's book (or skipped for lacking a catalogId, which is every book
// WordByWord sends). So pushing `books: [{ id: <victim's book> }]` alongside
// children let a client INSERT chapters/sections under someone else's book and
// UPDATE that user's existing chapters/sections. Only a book this user owns (or
// just created in this push) may unlock its children.

const syncService = await loadSyncService();

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const VICTIM = '99999999-9999-4999-8999-999999999999';
const MY_BOOK = '0b601a2d-0c33-4350-b915-44a5cff33058';
const VICTIM_BOOK = '88888888-8888-4888-8888-888888888888';
const VICTIM_CHAPTER = '55555555-5555-4555-8555-555555555555';
const VICTIM_SECTION = '66666666-6666-4666-8666-666666666666';
const NEW_CHAPTER = 'b936074f-4442-4f66-af02-25afc7959942';
const NEW_SECTION = '77777777-7777-4777-8777-777777777777';
const NEW_VOCAB = '44444444-4444-4444-8444-444444444444';

const SERVER_TIME = new Date('2026-09-01T00:00:00.000Z');
const NEWER = '2026-09-16T00:00:00.000Z';

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
const push = (changes: Partial<typeof emptyChanges>) =>
  syncService.sync(USER, { lastSyncedAt: '2026-09-15T00:00:00.000Z', changes: { ...emptyChanges, ...changes } as any });

// WordByWord's bookToSync shape: no catalogId.
const bookPush = (id: string) => ({ id, customTitle: 'x', updatedAt: NEWER });
const chapterPush = (id: string, bookId: string) =>
  ({ id, bookId, title: 'Pages 1-1', startPage: 1, endPage: 1, sortOrder: 0, updatedAt: NEWER });
const sectionPush = (id: string, bookId: string, chapterId: string) => ({
  id, bookId, chapterId, title: 'Page 1', startPage: 1, endPage: 1, isRead: true, readAt: NEWER,
  lastPageViewed: 1, scrollProgress: 1, sortOrder: 0, sectionType: 'content', extractedText: 'injected', updatedAt: NEWER,
});

beforeEach(() => {
  resetDb();
  db.books.seed({ id: MY_BOOK, userId: USER, catalogId: 'cat', updatedAt: SERVER_TIME });
  db.books.seed({ id: VICTIM_BOOK, userId: VICTIM, catalogId: 'cat2', updatedAt: SERVER_TIME });
  db.chapters.seed({ id: VICTIM_CHAPTER, bookId: VICTIM_BOOK, title: 'Victim chapter', updatedAt: SERVER_TIME });
  db.sections.seed({
    id: VICTIM_SECTION, bookId: VICTIM_BOOK, chapterId: VICTIM_CHAPTER, title: 'Victim section',
    isRead: false, readAt: null, scrollProgress: 0, extractedText: 'original', updatedAt: SERVER_TIME,
  });
});

describe("syncService.sync — pushing another user's book id", () => {
  it('does not create a chapter, section or vocab word under that book', async () => {
    const res = await push({
      books: [bookPush(VICTIM_BOOK)] as any,
      chapters: [chapterPush(NEW_CHAPTER, VICTIM_BOOK)],
      sections: [sectionPush(NEW_SECTION, VICTIM_BOOK, NEW_CHAPTER)],
      vocabulary: [{ id: NEW_VOCAB, bookId: VICTIM_BOOK, word: 'w', updatedAt: NEWER }] as any,
    });

    expect(db.chapters.create).not.toHaveBeenCalled();
    expect(db.sections.create).not.toHaveBeenCalled();
    expect(db.vocab.create).not.toHaveBeenCalled();
    expect(db.chapters.rows.has(NEW_CHAPTER)).toBe(false);
    expect(db.sections.rows.has(NEW_SECTION)).toBe(false);
    expect(res.failedEntities).toMatchObject({ chapters: [], sections: [], vocabulary: [] });
  });

  it("does not update or delete that user's existing chapters and sections", async () => {
    await push({
      books: [bookPush(VICTIM_BOOK)] as any,
      chapters: [{ ...chapterPush(VICTIM_CHAPTER, VICTIM_BOOK), title: 'pwned' }],
      sections: [
        sectionPush(VICTIM_SECTION, VICTIM_BOOK, VICTIM_CHAPTER),
        { ...sectionPush(VICTIM_SECTION, VICTIM_BOOK, VICTIM_CHAPTER), deletedAt: NEWER },
      ],
    });

    expect(db.chapters.update).not.toHaveBeenCalled();
    expect(db.chapters.softDelete).not.toHaveBeenCalled();
    expect(db.sections.update).not.toHaveBeenCalled();
    expect(db.sections.softDelete).not.toHaveBeenCalled();
    expect(db.chapters.rows.get(VICTIM_CHAPTER)).toMatchObject({ title: 'Victim chapter', deletedAt: null, updatedAt: SERVER_TIME });
    expect(db.sections.rows.get(VICTIM_SECTION)).toMatchObject({
      isRead: false, extractedText: 'original', deletedAt: null, updatedAt: SERVER_TIME,
    });
  });

  it('is not unlocked by also pushing the id with a catalogId', async () => {
    await push({
      books: [{ ...bookPush(VICTIM_BOOK), catalogId: '12121212-1212-4212-8212-121212121212' }] as any,
      chapters: [chapterPush(NEW_CHAPTER, VICTIM_BOOK)],
    });

    expect(db.books.create).not.toHaveBeenCalled();
    expect(db.books.update).not.toHaveBeenCalled();
    expect(db.chapters.create).not.toHaveBeenCalled();
  });
});

describe('syncService.sync — pushed book ids that do unlock their children', () => {
  it("still accepts new children under the user's own book pushed without a catalogId", async () => {
    const res = await push({
      books: [bookPush(MY_BOOK)] as any,
      chapters: [chapterPush(NEW_CHAPTER, MY_BOOK)],
      sections: [sectionPush(NEW_SECTION, MY_BOOK, NEW_CHAPTER)],
    });

    expect(db.chapters.create).toHaveBeenCalledTimes(1);
    expect(db.sections.create).toHaveBeenCalledTimes(1);
    expect(res.failedEntities).toMatchObject({ chapters: [], sections: [] });
  });

  it('still accepts children under a book created in the same push', async () => {
    const NEW_BOOK = '22222222-2222-4222-8222-222222222222';
    await push({
      books: [{ ...bookPush(NEW_BOOK), catalogId: '12121212-1212-4212-8212-121212121212' }] as any,
      chapters: [chapterPush(NEW_CHAPTER, NEW_BOOK)],
      sections: [sectionPush(NEW_SECTION, NEW_BOOK, NEW_CHAPTER)],
    });

    expect(db.books.rows.get(NEW_BOOK)?.userId).toBe(USER);
    expect(db.chapters.create).toHaveBeenCalledTimes(1);
    expect(db.sections.create).toHaveBeenCalledTimes(1);
  });

  it("but not the user's own book once the server has soft-deleted it", async () => {
    db.books.seed({ id: MY_BOOK, userId: USER, catalogId: 'cat', deletedAt: SERVER_TIME, updatedAt: SERVER_TIME });
    await push({
      books: [bookPush(MY_BOOK)] as any,
      chapters: [chapterPush(NEW_CHAPTER, MY_BOOK)],
    });

    expect(db.chapters.create).not.toHaveBeenCalled();
  });
});
