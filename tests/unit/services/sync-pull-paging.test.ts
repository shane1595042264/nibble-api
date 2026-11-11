import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, pull, loadSyncService, resetDb } from './sync-harness.js';

// The chapter/section pull used to stop at 5000 rows (no ORDER BY, no signal),
// while syncedAt still advanced to the request time, so the dropped rows were
// never sent again and a fresh device silently lost random sections (KAN-397).
// Now each is paged by id: a capped page returns pullCursor, and the client
// re-asks with the same lastSyncedAt until it comes back null.

const syncService = await loadSyncService();

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const BOOK = '0b601a2d-0c33-4350-b915-44a5cff33058';
const T0 = new Date('2026-11-10T12:00:00.000Z').getTime();
const EPOCH = '1970-01-01T00:00:00.000Z';
const sectionId = (n: number) => `5ec00000-0000-4000-8000-00000000000${n}`;
const chapterId = (n: number) => `c4a00000-0000-4000-8000-00000000000${n}`;

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
type Cursor = { chapters?: string; sections?: string };
const sync = (lastSyncedAt: string, pullCursor?: Cursor) =>
  syncService.sync(USER, { lastSyncedAt, changes: emptyChanges as any, pullCursor });

/** What the client does: the first page, then continuation pages until pullCursor is null. */
async function pullAll(lastSyncedAt: string) {
  const first = await sync(lastSyncedAt);
  const pages = [first];
  let cursor = first.pullCursor;
  while (cursor) {
    const next = await sync(lastSyncedAt, cursor);
    pages.push(next);
    cursor = next.pullCursor;
  }
  return pages;
}

beforeEach(() => {
  resetDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  pull.pageSize = 3;
  db.books.seed({ id: BOOK, userId: USER, catalogId: 'cat', title: 'Big book', updatedAt: new Date(T0 - 60_000) });
  for (let n = 1; n <= 7; n++) db.sections.seed({ id: sectionId(n), bookId: BOOK, updatedAt: new Date(T0 - 60_000) });
  for (let n = 1; n <= 2; n++) db.chapters.seed({ id: chapterId(n), bookId: BOOK, updatedAt: new Date(T0 - 60_000) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('syncService.sync — chapter/section pull paging', () => {
  it('pages past the cap until every section has been sent exactly once', async () => {
    const pages = await pullAll(EPOCH);

    expect(pages).toHaveLength(3);
    const sent = pages.flatMap((p) => p.serverChanges.sections.map((s) => s.id));
    expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7].map(sectionId));
    expect(pages[0].pullCursor).toEqual({ sections: sectionId(3) });
    expect(pages[1].pullCursor).toEqual({ sections: sectionId(6) });
    expect(pages[2].pullCursor).toBeNull();
  });

  it('does not re-send a finished entity or the non-paged ones on a continuation page', async () => {
    const [first, ...rest] = await pullAll(EPOCH);

    expect(first.serverChanges.chapters.map((c) => c.id)).toEqual([chapterId(1), chapterId(2)]);
    expect(first.serverChanges.books.map((b) => b.id)).toEqual([BOOK]);
    for (const page of rest) {
      expect(page.serverChanges.chapters).toEqual([]);
      expect(page.serverChanges.books).toEqual([]);
      expect(page.serverChanges.vocabulary).toEqual([]);
      expect(page.serverChanges.settings).toBeNull();
    }
  });

  it('returns no cursor when the result fits in one page', async () => {
    pull.pageSize = 7;
    const pages = await pullAll(EPOCH);
    expect(pages).toHaveLength(1);
    expect(pages[0].serverChanges.sections).toHaveLength(7);
  });

  it('a row edited behind the cursor mid-paging is re-pulled by the next sync from the first page watermark', async () => {
    const first = await sync(EPOCH);
    vi.setSystemTime(T0 + 5_000);
    await db.sections.update(sectionId(1), { scrollProgress: 0.5 });
    await sync(EPOCH, first.pullCursor!);

    vi.setSystemTime(T0 + 30_000);
    const next = await pullAll(first.syncedAt);
    expect(next.flatMap((p) => p.serverChanges.sections.map((s) => s.id))).toEqual([sectionId(1)]);
  });
});
