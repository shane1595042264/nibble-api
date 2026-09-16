import { describe, it, expect, beforeEach } from 'vitest';
import { db, loadSyncService, resetDb } from './sync-harness.js';

// WordByWord's bookToSync never sends catalogId — books only reach the server
// through the /books upload routes, never through sync. The books loop skipped
// every pushed book without one BEFORE looking up the server row, so the update
// path was unreachable from the real client: on prod, 0 of 13 books had ever had
// last_read_at or a reading position written, and renames never left the device.
// catalogId is only needed to INSERT a row, so only the create branch requires it.

const syncService = await loadSyncService();

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const BOOK = '0b601a2d-0c33-4350-b915-44a5cff33058';
const OTHER_BOOK = '88888888-8888-4888-8888-888888888888';
const SECTION = 'fe8dccaf-57f5-4f6a-ad2a-9d345924acb1';
const OLD_SECTION = '1c8c1a29-bdde-41e9-91f1-4caf55a81f5e';

const SERVER_TIME = new Date('2026-09-01T00:00:00.000Z');
const NEWER = '2026-09-16T18:00:00.000Z';
const LAST_SYNCED = '2026-09-15T00:00:00.000Z';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
const push = (changes: Partial<typeof emptyChanges>) =>
  syncService.sync(USER, { lastSyncedAt: LAST_SYNCED, changes: { ...emptyChanges, ...changes } as any });

// Exactly what bookToSync sends. Already-deployed clients still include coverUrl.
const bookPush = (over: Record<string, unknown> = {}) => ({
  id: BOOK,
  customTitle: 'Renamed on laptop',
  coverUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA',
  lastReadAt: NEWER,
  lastAccessedSectionId: SECTION,
  lastAccessedScrollProgress: 0.42,
  lastAccessedWordIndex: 7,
  updatedAt: NEWER,
  ...over,
});

beforeEach(() => {
  resetDb();
  db.books.seed({
    id: BOOK, userId: USER, catalogId: 'cat', customTitle: null, coverUrl: null, lastReadAt: null,
    lastAccessedSectionId: OLD_SECTION, lastAccessedScrollProgress: 0.1, lastAccessedWordIndex: null, updatedAt: SERVER_TIME,
  });
  db.books.seed({ id: OTHER_BOOK, userId: OTHER_USER, catalogId: 'cat2', customTitle: 'Theirs', lastAccessedScrollProgress: 0, updatedAt: SERVER_TIME });

  // books.last_accessed_section_id is a uuid column: Postgres rejects anything else (22P02).
  const write = db.books.update.getMockImplementation()!;
  db.books.update.mockImplementation(async (id: string, data: Record<string, unknown>) => {
    const sec = data.lastAccessedSectionId;
    if (sec != null && !UUID_RE.test(String(sec))) {
      throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
    }
    return write(id, data);
  });
});

describe('syncService.sync — a book pushed in bookToSync shape (no catalogId)', () => {
  it("applies a newer client's reading position and title to the user's own book", async () => {
    const res = await push({ books: [bookPush()] as any });

    expect(res.failedEntities.books).toEqual([]);
    expect(db.books.rows.get(BOOK)).toMatchObject({
      userId: USER,
      catalogId: 'cat',
      customTitle: 'Renamed on laptop',
      lastReadAt: new Date(NEWER),
      lastAccessedSectionId: SECTION,
      lastAccessedScrollProgress: 0.42,
      lastAccessedWordIndex: 7,
    });
  });

  it("reaches the user's other devices on their next pull", async () => {
    await push({ books: [bookPush()] as any });
    const otherDevice = await push({});

    const book = otherDevice.serverChanges.books.find((b) => b.id === BOOK);
    expect(book).toMatchObject({ customTitle: 'Renamed on laptop', lastAccessedSectionId: SECTION, lastAccessedScrollProgress: 0.42 });
  });

  it('does not write the pushed cover — the client sends a data: URL rendered from page 1', async () => {
    await push({ books: [bookPush()] as any });

    expect(db.books.update).toHaveBeenCalledTimes(1);
    expect(db.books.update.mock.calls[0][1]).not.toHaveProperty('coverUrl');
    expect(db.books.rows.get(BOOK)?.coverUrl).toBeNull();
  });

  it('drops a lastAccessedSectionId that is not a uuid instead of failing the book on every sync', async () => {
    const res = await push({ books: [bookPush({ lastAccessedSectionId: 'not-a-section' })] as any });

    expect(res.failedEntities.books).toEqual([]);
    expect(db.books.rows.get(BOOK)).toMatchObject({
      customTitle: 'Renamed on laptop',
      lastAccessedScrollProgress: 0.42,
      lastAccessedSectionId: OLD_SECTION,
    });
  });

  it('still clears lastAccessedSectionId when the client sends null', async () => {
    await push({ books: [bookPush({ lastAccessedSectionId: null })] as any });

    expect(db.books.rows.get(BOOK)?.lastAccessedSectionId).toBeNull();
  });

  it('leaves the row alone when the client copy is not newer', async () => {
    await push({ books: [bookPush({ updatedAt: SERVER_TIME.toISOString() })] as any });

    expect(db.books.update).not.toHaveBeenCalled();
    expect(db.books.rows.get(BOOK)).toMatchObject({ customTitle: null, lastAccessedScrollProgress: 0.1 });
  });

  it("still never updates another user's book", async () => {
    const res = await push({ books: [bookPush({ id: OTHER_BOOK })] as any });

    expect(db.books.update).not.toHaveBeenCalled();
    expect(db.books.rows.get(OTHER_BOOK)).toMatchObject({ customTitle: 'Theirs', lastAccessedScrollProgress: 0 });
    expect(res.failedEntities.books).toEqual([]);
  });

  it('still needs a catalogId to create a book the server has never seen', async () => {
    const UNKNOWN = '22222222-2222-4222-8222-222222222222';
    const res = await push({ books: [bookPush({ id: UNKNOWN })] as any });

    expect(db.books.create).not.toHaveBeenCalled();
    expect(db.books.rows.has(UNKNOWN)).toBe(false);
    expect(res.failedEntities.books).toEqual([]);
  });
});
