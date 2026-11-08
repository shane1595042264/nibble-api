import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// GET /books/:id/download put the raw catalog title in Content-Disposition.
// Header values must be ByteStrings, so any title with a code point above 255
// (em dash, curly quote, CJK) made Headers.set throw and the download 500 (KAN-391).
const bookService = vi.hoisted(() => ({ getBook: vi.fn() }));
vi.mock('../../../src/services/book.service.js', () => ({ bookService }));

const bookRepo = vi.hoisted(() => ({ findCatalogById: vi.fn() }));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

vi.mock('../../../src/db/index.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ r2Key: 'books/x.pdf' }] }) }) }) },
}));

const storage = vi.hoisted(() => ({ openBookFileStream: vi.fn() }));
vi.mock('../../../src/services/storage.service.js', () => ({ storageService: storage }));

const { bookRoutes, contentDisposition } = await import('../../../src/routes/books.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const BYTES = new TextEncoder().encode('%PDF-1.4 test %%EOF');

function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('/books/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/books', bookRoutes);
  return app;
}

const download = () => makeApp().request(`/books/${BOOK_ID}/download`);

/** Decode the filename*= parameter back to a string. */
function extFilename(header: string): string {
  const m = header.match(/filename\*=UTF-8''([^;\s]+)/);
  if (!m) throw new Error(`no filename*= in ${header}`);
  return decodeURIComponent(m[1]);
}

function asciiFilename(header: string): string {
  const m = header.match(/filename="([^"]*)"/);
  if (!m) throw new Error(`no filename= in ${header}`);
  return m[1];
}

describe('GET /books/:id/download Content-Disposition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bookService.getBook.mockResolvedValue({ id: BOOK_ID, catalogId: 'cat' });
    storage.openBookFileStream.mockImplementation(async () => ({
      stream: new Response(BYTES).body!,
      contentLength: BYTES.length,
    }));
  });

  it.each([
    ['ASCII', 'Godel Escher Bach'],
    ['Latin-1', 'Gödel, Escher, Bach'],
    ['em dash', 'Algorithms — 4th Edition'],
    ['curly apostrophe', 'Don’t Make Me Think'],
    ['CJK', '算法导论'],
    ['emoji', 'Reading 📚 Club'],
  ])('returns 200 for a %s title and round-trips it through filename*=', async (_label, title) => {
    bookRepo.findCatalogById.mockResolvedValue({ title, format: 'pdf', fileHash: 'h' });

    const res = await download();

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    const header = res.headers.get('Content-Disposition')!;
    expect(header).toMatch(/^attachment; /);
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(extFilename(header)).toBe(`${title}.pdf`);
    expect(asciiFilename(header)).toMatch(/^[\x20-\x7e]+\.pdf$/);
  });

  it('keeps the plain filename= unchanged for an ASCII title', async () => {
    bookRepo.findCatalogById.mockResolvedValue({ title: 'Clean Code', format: 'epub', fileHash: 'h' });

    const res = await download();

    expect(res.headers.get('Content-Type')).toBe('application/epub+zip');
    expect(asciiFilename(res.headers.get('Content-Disposition')!)).toBe('Clean Code.epub');
  });

  it('does not open the R2 stream when the catalog entry is missing', async () => {
    bookRepo.findCatalogById.mockResolvedValue(undefined);

    const res = await download();

    expect(res.status).toBe(404);
    expect(storage.openBookFileStream).not.toHaveBeenCalled();
  });
});

describe('contentDisposition', () => {
  it('replaces non-ASCII in the fallback and keeps the real title in filename*=', () => {
    const header = contentDisposition('A — B', 'pdf');
    expect(asciiFilename(header)).toBe('A _ B.pdf');
    expect(extFilename(header)).toBe('A — B.pdf');
  });

  it("percent-encodes ' ( ) which RFC 5987 does not allow raw", () => {
    const header = contentDisposition("O'Reilly (2nd)", 'pdf');
    expect(header).toContain("filename*=UTF-8''O%27Reilly%20%282nd%29.pdf");
  });

  it('never splits a surrogate pair at the length cap', () => {
    const header = contentDisposition('a'.repeat(99) + '📚📚', 'pdf');
    expect(extFilename(header)).toBe('a'.repeat(99) + '📚.pdf');
  });

  it('survives a lone surrogate instead of throwing', () => {
    const header = contentDisposition('bad \uD800 title', 'pdf');
    expect(extFilename(header)).toBe('bad � title.pdf');
  });

  it('still strips quotes, backslashes and control chars', () => {
    const header = contentDisposition('a"b\\c\r\nd/e', 'pdf');
    expect(asciiFilename(header)).toBe('abcd_e.pdf');
  });

  it('falls back to "download" when nothing survives sanitizing', () => {
    expect(asciiFilename(contentDisposition('""', 'pdf'))).toBe('download.pdf');
  });
});
