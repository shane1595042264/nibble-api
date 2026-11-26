import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Marketplace search filtered on similarity(whole title, query) > 0.3, so one
// word of a long title ("Spring" vs "Spring Boot: Up and Running", 0.28) was
// dropped (KAN-423). It must match words and substrings of the title.
const calls = vi.hoisted(() => ({ where: [] as unknown[], orderBy: [] as unknown[][] }));
vi.mock('../../../src/db/index.js', () => {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: (w: unknown) => { calls.where.push(w); return chain; },
    orderBy: (...o: unknown[]) => { calls.orderBy.push(o); return chain; },
    limit: async () => [],
  };
  return { db: chain };
});

const { bookRepository } = await import('../../../src/repositories/book.repository.js');
const dialect = new PgDialect();
const render = (s: unknown) => dialect.sqlToQuery(s as SQL);

beforeEach(() => {
  calls.where.length = 0;
  calls.orderBy.length = 0;
});

describe('bookRepository.findCatalogByFuzzyTitle', () => {
  it('matches a word of the title, not only the whole title', async () => {
    await bookRepository.findCatalogByFuzzyTitle('Spring');

    const where = render(calls.where[0]);
    expect(where.sql).toContain('word_similarity($1, "book_catalog"."title") > 0.3');
    expect(where.sql).toContain('"book_catalog"."title" ILIKE $2');
    expect(where.sql).not.toMatch(/(^|[^_])similarity\(/);
    expect(where.params).toEqual(['Spring', '%Spring%']);
  });

  it('ranks by word match, then whole-title similarity so the exact title comes first', async () => {
    await bookRepository.findCatalogByFuzzyTitle('Spring');

    const [byWord, byTitle] = calls.orderBy[0].map(render);
    expect(byWord.sql).toBe('word_similarity($1, "book_catalog"."title") desc');
    expect(byTitle.sql).toBe('similarity("book_catalog"."title", $1) desc');
  });

  it('escapes LIKE wildcards so % and _ match literally', async () => {
    await bookRepository.findCatalogByFuzzyTitle('100%_C\\D');

    expect(render(calls.where[0]).params[1]).toBe('%100\\%\\_C\\\\D%');
  });
});
