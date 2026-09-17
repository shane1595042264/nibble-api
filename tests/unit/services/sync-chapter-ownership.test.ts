import { describe, it, expect, beforeEach } from 'vitest';
import { db, loadSyncService, resetDb } from './sync-harness.js';

// A new section is inserted with the client's bookId and chapterId verbatim, and the
// only gate on chapterId was existingChapterIdSet: built from findByIds with no
// ownership filter, then topped up with every pushed non-deleted chapter id — even
// ones the chapters loop had just skipped. So `sections: [{ bookId: <my book>,
// chapterId: <victim's chapter> }]` inserted a row both FKs accept, and
// GET /api/sections?chapterId=<victim's chapter> (which checks the chapter's owner)
// then listed the injected section to the victim. A section may only attach to a
// live chapter of its own owned book: an existing one, or one this push created.

const syncService = await loadSyncService();

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const VICTIM = '99999999-9999-4999-8999-999999999999';
const MY_BOOK = '0b601a2d-0c33-4350-b915-44a5cff33058';
const MY_OTHER_BOOK = '33333333-3333-4333-8333-333333333333';
const VICTIM_BOOK = '88888888-8888-4888-8888-888888888888';
const MY_CHAPTER = '1c8c1a29-6d5e-4f3b-9a8e-2b7c4d5e6f70';
const MY_OTHER_CHAPTER = '11111111-1111-4111-8111-111111111111';
const VICTIM_CHAPTER = '55555555-5555-4555-8555-555555555555';
const MY_SECTION = 'fe8dccaf-3b2a-4c1d-8e9f-0a1b2c3d4e5f';
const NEW_CHAPTER = 'b936074f-4442-4f66-af02-25afc7959942';
const NEW_SECTION = '77777777-7777-4777-8777-777777777777';
const NEW_SECTION_2 = '66666666-6666-4666-8666-666666666666';

const SERVER_TIME = new Date('2026-09-01T00:00:00.000Z');
const NEWER = '2026-09-16T00:00:00.000Z';

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
const push = (changes: Partial<typeof emptyChanges>) =>
  syncService.sync(USER, { lastSyncedAt: '2026-09-15T00:00:00.000Z', changes: { ...emptyChanges, ...changes } as any });

// WordByWord's chapterToSync / sectionToSync shapes.
const chapterPush = (id: string, bookId: string) =>
  ({ id, bookId, title: 'Pages 1-1', startPage: 1, endPage: 1, sortOrder: 0, updatedAt: NEWER });
const sectionPush = (id: string, bookId: string | undefined, chapterId: string) => ({
  id, bookId, chapterId, title: 'Page 1', startPage: 1, endPage: 1, isRead: true, readAt: NEWER,
  lastPageViewed: 1, scrollProgress: 1, sortOrder: 0, sectionType: 'content', extractedText: 'injected', updatedAt: NEWER,
});

beforeEach(() => {
  resetDb();
  db.books.seed({ id: MY_BOOK, userId: USER, catalogId: 'cat', updatedAt: SERVER_TIME });
  db.books.seed({ id: MY_OTHER_BOOK, userId: USER, catalogId: 'cat3', updatedAt: SERVER_TIME });
  db.books.seed({ id: VICTIM_BOOK, userId: VICTIM, catalogId: 'cat2', updatedAt: SERVER_TIME });
  db.chapters.seed({ id: MY_CHAPTER, bookId: MY_BOOK, title: 'My chapter', updatedAt: SERVER_TIME });
  db.chapters.seed({ id: MY_OTHER_CHAPTER, bookId: MY_OTHER_BOOK, title: 'My other chapter', updatedAt: SERVER_TIME });
  db.chapters.seed({ id: VICTIM_CHAPTER, bookId: VICTIM_BOOK, title: 'Victim chapter', updatedAt: SERVER_TIME });
  db.sections.seed({
    id: MY_SECTION, bookId: MY_BOOK, chapterId: MY_CHAPTER, title: 'My section',
    isRead: false, readAt: null, scrollProgress: 0, extractedText: 'original', updatedAt: SERVER_TIME,
  });
});

describe("syncService.sync — a new section's chapterId", () => {
  it("cannot be another user's existing chapter", async () => {
    const res = await push({ sections: [sectionPush(NEW_SECTION, MY_BOOK, VICTIM_CHAPTER)] });

    expect(db.sections.create).not.toHaveBeenCalled();
    expect(db.sections.rows.has(NEW_SECTION)).toBe(false);
    expect(res.failedEntities.sections).toEqual([]);
  });

  it("is not unlocked by also pushing that user's chapter id as one of my book's", async () => {
    await push({
      chapters: [chapterPush(VICTIM_CHAPTER, MY_BOOK)],
      sections: [sectionPush(NEW_SECTION, MY_BOOK, VICTIM_CHAPTER)],
    });

    expect(db.chapters.update).not.toHaveBeenCalled();
    expect(db.sections.create).not.toHaveBeenCalled();
  });

  it('is not unlocked by a chapter the same push skipped', async () => {
    const res = await push({
      chapters: [chapterPush(NEW_CHAPTER, VICTIM_BOOK)],
      sections: [sectionPush(NEW_SECTION, MY_BOOK, NEW_CHAPTER)],
    });

    expect(db.chapters.create).not.toHaveBeenCalled();
    expect(db.sections.create).not.toHaveBeenCalled();
    expect(res.failedEntities).toMatchObject({ chapters: [], sections: [] });
  });

  it("must be a chapter of the section's own book, not another book of this user", async () => {
    await push({
      chapters: [chapterPush(NEW_CHAPTER, MY_OTHER_BOOK)],
      sections: [
        sectionPush(NEW_SECTION, MY_BOOK, MY_OTHER_CHAPTER), // existing chapter
        sectionPush(NEW_SECTION_2, MY_BOOK, NEW_CHAPTER), // chapter created by this push
      ],
    });

    expect(db.chapters.create).toHaveBeenCalledTimes(1);
    expect(db.sections.create).not.toHaveBeenCalled();
  });

  it('is not accepted when the section omits bookId', async () => {
    await push({
      sections: [sectionPush(NEW_SECTION, undefined, VICTIM_CHAPTER), sectionPush(NEW_SECTION_2, undefined, MY_CHAPTER)],
    });

    expect(db.sections.create).not.toHaveBeenCalled();
  });

  it('cannot be a chapter this push deletes', async () => {
    await push({
      chapters: [{ ...chapterPush(MY_CHAPTER, MY_BOOK), deletedAt: NEWER }],
      sections: [sectionPush(NEW_SECTION, MY_BOOK, MY_CHAPTER)],
    });

    expect(db.chapters.softDelete).toHaveBeenCalledWith(MY_CHAPTER);
    expect(db.sections.create).not.toHaveBeenCalled();
  });
});

describe("syncService.sync — sections under the user's own chapters", () => {
  it('still creates a new section under an existing chapter of its book', async () => {
    const res = await push({ sections: [sectionPush(NEW_SECTION, MY_BOOK, MY_CHAPTER)] });

    expect(db.sections.create).toHaveBeenCalledTimes(1);
    expect(db.sections.rows.get(NEW_SECTION)).toMatchObject({ bookId: MY_BOOK, chapterId: MY_CHAPTER });
    expect(res.failedEntities.sections).toEqual([]);
  });

  it('still creates a new section under a chapter created in the same push', async () => {
    const res = await push({
      chapters: [chapterPush(NEW_CHAPTER, MY_BOOK)],
      sections: [sectionPush(NEW_SECTION, MY_BOOK, NEW_CHAPTER)],
    });

    expect(db.chapters.create).toHaveBeenCalledTimes(1);
    expect(db.sections.rows.get(NEW_SECTION)).toMatchObject({ bookId: MY_BOOK, chapterId: NEW_CHAPTER });
    expect(res.failedEntities).toMatchObject({ chapters: [], sections: [] });
  });

  it('still applies an update to an existing section', async () => {
    const res = await push({ sections: [sectionPush(MY_SECTION, MY_BOOK, MY_CHAPTER)] });

    expect(db.sections.update).toHaveBeenCalledTimes(1);
    expect(db.sections.rows.get(MY_SECTION)).toMatchObject({ isRead: true, extractedText: 'injected' });
    expect(res.failedEntities.sections).toEqual([]);
  });

  // Postgres used to fail this section on the chapter_id FK, so the client retried both.
  // Gating on created chapters must not turn that into a silent drop of the section.
  it('fails, rather than drops, a new section whose chapter failed to insert in the same push', async () => {
    db.chapters.create.mockRejectedValueOnce(new Error('connection reset'));
    const res = await push({
      chapters: [chapterPush(NEW_CHAPTER, MY_BOOK)],
      sections: [sectionPush(NEW_SECTION, MY_BOOK, NEW_CHAPTER)],
    });

    expect(db.sections.create).not.toHaveBeenCalled();
    expect(res.failedEntities).toMatchObject({ chapters: [NEW_CHAPTER], sections: [NEW_SECTION] });
  });
});
