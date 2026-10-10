import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, loadSyncService, resetDb } from './sync-harness.js';

// The returned syncedAt is the client's next pull cursor. It used to be taken
// after every step-2 read, so a row another device wrote while those reads ran
// (after the books read, before the response) got updatedAt < syncedAt: missing
// from this response and filtered out of every later incremental pull too.

const syncService = await loadSyncService();

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const BOOK = '0b601a2d-0c33-4350-b915-44a5cff33058';
const T0 = new Date('2026-10-10T12:00:00.000Z').getTime();

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
const pull = (lastSyncedAt: string) => syncService.sync(USER, { lastSyncedAt, changes: emptyChanges as any });
const bookIds = (res: Awaited<ReturnType<typeof pull>>) => res.serverChanges.books.map((b) => b.id);

beforeEach(() => {
  resetDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db.books.seed({ id: BOOK, userId: USER, catalogId: 'cat', title: 'Old title', updatedAt: new Date(T0 - 60_000) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('syncService.sync — syncedAt watermark', () => {
  it('re-pulls a row another device wrote while the step-2 reads were running', async () => {
    const read = db.books.findModifiedSince;
    vi.spyOn(db.books, 'findModifiedSince').mockImplementationOnce(async (...args) => {
      // Copies, like a real query result — the update below must not leak into them.
      const rows = (await read(...args)).map((r) => ({ ...r }));
      // Device B renames the book right after our books read...
      vi.setSystemTime(T0 + 50);
      await db.books.update(BOOK, { title: 'Renamed on device B' });
      // ...and the remaining reads take a while longer.
      vi.setSystemTime(T0 + 200);
      return rows;
    });

    const first = await pull('2026-10-10T11:00:00.000Z');
    expect(first.serverChanges.books[0]).toMatchObject({ id: BOOK, title: 'Old title' });
    expect(new Date(first.syncedAt).getTime()).toBeLessThanOrEqual(db.books.rows.get(BOOK)!.updatedAt.getTime());

    vi.setSystemTime(T0 + 30_000);
    const second = await pull(first.syncedAt);
    expect(second.serverChanges.books[0]).toMatchObject({ id: BOOK, title: 'Renamed on device B' });
  });

  it('still converges: a quiet follow-up sync pulls nothing', async () => {
    const first = await pull('1970-01-01T00:00:00.000Z');
    expect(bookIds(first)).toEqual([BOOK]);

    vi.setSystemTime(T0 + 30_000);
    const second = await pull(first.syncedAt);
    expect(bookIds(second)).toEqual([]);
    expect(new Date(second.syncedAt).getTime()).toBeGreaterThan(new Date(first.syncedAt).getTime());
  });
});
