import { vi } from 'vitest';

// In-memory stand-ins for every repository syncService.sync() touches, so the
// push/pull logic runs end to end without Postgres. Shared by the sync-*.test.ts
// files: call resetDb() in beforeEach, then seed rows through `db`.

export type Row = { id: string; deletedAt: Date | null; updatedAt: Date; [k: string]: unknown };

const pkViolation = (table: string) =>
  Object.assign(new Error(`Failed query: insert into "${table}"`), {
    cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
  });

/** In-memory table with the same soft-delete + primary-key semantics as the real repositories. */
export function table(name: string) {
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

type Table = ReturnType<typeof table>;

/** The mocked repositories read through these handles, so resetDb() swaps in empty tables. */
export const db = {} as { books: Table; chapters: Table; sections: Table; vocab: Table };
export const forward = vi.fn();

export function resetDb() {
  db.books = table('books');
  db.chapters = table('chapters');
  db.sections = table('sections');
  db.vocab = table('vocabulary');
  forward.mockReset();
}

/** Mock the repositories and the knowledge-base forward, then load the real sync service. */
export async function loadSyncService() {
  vi.doMock('../../../src/repositories/book.repository.js', () => ({
    bookRepository: {
      findByIds: (...a: Parameters<Table['findByIds']>) => db.books.findByIds(...a),
      findModifiedSince: (...a: [string, Date]) => db.books.findModifiedSince(...a),
      findByUserId: async (userId: string) => [...db.books.rows.values()].filter((b) => b.userId === userId && !b.deletedAt),
      findCatalogByIds: async () => [],
      create: (d: Record<string, unknown>) => db.books.create(d),
      update: (id: string, d: Record<string, unknown>) => db.books.update(id, d),
      softDelete: (id: string) => db.books.softDelete(id),
    },
  }));
  vi.doMock('../../../src/repositories/chapter.repository.js', () => ({
    chapterRepository: new Proxy({}, { get: (_, k) => (db.chapters as any)[k] }),
  }));
  vi.doMock('../../../src/repositories/section.repository.js', () => ({
    sectionRepository: new Proxy({}, { get: (_, k) => (db.sections as any)[k] }),
  }));
  vi.doMock('../../../src/repositories/vocabulary.repository.js', () => ({
    vocabularyRepository: new Proxy({}, { get: (_, k) => (db.vocab as any)[k] }),
  }));
  vi.doMock('../../../src/repositories/settings.repository.js', () => ({
    settingsRepository: { upsert: vi.fn(), findModifiedSince: async () => null },
  }));
  vi.doMock('../../../src/repositories/exercise.repository.js', () => ({
    exerciseRepository: { findProgressByUserId: async () => [], findProgressModifiedSince: async () => [], findByCatalogIds: async () => [] },
  }));
  vi.doMock('../../../src/services/knowledge-base.service.js', () => ({ forwardVocabToKnowledgeBase: forward }));

  const { syncService } = await import('../../../src/services/sync.service.js');
  return syncService;
}
