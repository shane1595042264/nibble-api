import { describe, it, expect, beforeEach } from 'vitest';
import { db, loadSyncService, resetDb } from './sync-harness.js';

// The server-wins branch of the section loop always wrote progressMerge, even when it
// matched the stored row. That write bumps updated_at, the pull returns the row, the
// client adopts the new stamp and re-pushes the row on its next sync (its push cursor
// sits before the stamp), and the server rewrites it again — forever (KAN-406). A
// merge that changes nothing must write nothing; one that does must still land.

const syncService = await loadSyncService();

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const BOOK = '0b601a2d-0c33-4350-b915-44a5cff33058';
const CHAPTER = '1c8c1a29-6d5e-4f3b-9a8e-2b7c4d5e6f70';
const SECTION = 'fe8dccaf-3b2a-4c1d-8e9f-0a1b2c3d4e5f';

const SERVER_TIME = new Date('2026-09-01T00:00:00.000Z');
const READ_AT = new Date('2026-08-30T00:00:00.000Z');
const OLDER = '2026-08-01T00:00:00.000Z';

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
const push = (sections: unknown[]) =>
  syncService.sync(USER, { lastSyncedAt: '2026-09-15T00:00:00.000Z', changes: { ...emptyChanges, sections } as any });

// WordByWord's sectionToSync shape, echoing the server row unless overridden.
const sectionPush = (overrides: Record<string, unknown> = {}) => ({
  id: SECTION, bookId: BOOK, chapterId: CHAPTER, title: 'Page 1', startPage: 1, endPage: 1,
  isRead: true, readAt: READ_AT.toISOString(), lastPageViewed: 1, scrollProgress: 0.3, sortOrder: 0,
  sectionType: 'content', extractedText: 'x'.repeat(1000), updatedAt: SERVER_TIME.toISOString(), ...overrides,
});

beforeEach(() => {
  resetDb();
  db.books.seed({ id: BOOK, userId: USER, catalogId: 'cat', updatedAt: SERVER_TIME });
  db.chapters.seed({ id: CHAPTER, bookId: BOOK, title: 'Chapter', updatedAt: SERVER_TIME });
  db.sections.seed({
    id: SECTION, bookId: BOOK, chapterId: CHAPTER, title: 'Page 1',
    // 0.3 as read back from the float4 column, not the double the client holds.
    isRead: true, readAt: READ_AT, scrollProgress: Math.fround(0.3), updatedAt: SERVER_TIME,
  });
});

describe('syncService.sync — a section echoed at the server timestamp', () => {
  it('writes nothing when the progress merge matches the stored row', async () => {
    const res = await push([sectionPush()]);

    expect(db.sections.update).not.toHaveBeenCalled();
    expect(db.sections.rows.get(SECTION)!.updatedAt).toEqual(SERVER_TIME);
    expect(res.serverChanges.sections.map((s: any) => s.id)).not.toContain(SECTION);
    expect(res.failedEntities.sections).toEqual([]);
  });

  it('writes nothing for an older client row that is behind on every progress field', async () => {
    await push([sectionPush({ updatedAt: OLDER, isRead: false, readAt: null, scrollProgress: 0.1 })]);

    expect(db.sections.update).not.toHaveBeenCalled();
  });

  it('still takes a higher scrollProgress (max-wins)', async () => {
    await push([sectionPush({ scrollProgress: 0.8 })]);

    expect(db.sections.update).toHaveBeenCalledTimes(1);
    expect(db.sections.rows.get(SECTION)!.scrollProgress).toBe(0.8);
  });

  it('still takes isRead=true from an older client (true-wins)', async () => {
    const section = db.sections.rows.get(SECTION)!;
    Object.assign(section, { isRead: false, readAt: null });

    await push([sectionPush({ updatedAt: OLDER })]);

    expect(db.sections.update).toHaveBeenCalledTimes(1);
    expect(section.isRead).toBe(true);
    expect(section.readAt).toEqual(READ_AT);
  });

  it('still takes a more recent readAt when both sides are read', async () => {
    const later = new Date('2026-08-31T00:00:00.000Z');
    await push([sectionPush({ readAt: later.toISOString() })]);

    expect(db.sections.update).toHaveBeenCalledTimes(1);
    expect(db.sections.rows.get(SECTION)!.readAt).toEqual(later);
  });

  it('still heals an out-of-range stored scrollProgress', async () => {
    db.sections.rows.get(SECTION)!.scrollProgress = 1.5;

    await push([sectionPush({ scrollProgress: 0.3 })]);

    expect(db.sections.update).toHaveBeenCalledTimes(1);
    expect(db.sections.rows.get(SECTION)!.scrollProgress).toBe(1);
  });
});
