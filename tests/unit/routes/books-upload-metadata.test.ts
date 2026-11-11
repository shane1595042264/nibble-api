import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// POST /books/upload capped the file-metadata title/author at 255 and 400ed the
// whole upload past it, so a PDF with a long embedded author list could never be
// imported (KAN-398). They are now clamped to the same 500 used everywhere else.
const bookService = vi.hoisted(() => ({ handleUpload: vi.fn() }));
vi.mock('../../../src/services/book.service.js', () => ({ bookService }));

const { bookRoutes, clampUploadField, BOOK_AUTHOR_MAX, BOOK_CUSTOM_TITLE_MAX } =
  await import('../../../src/routes/books.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PDF = new TextEncoder().encode('%PDF-1.4 test %%EOF');

function upload(fields: Record<string, string>) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('/books/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/books', bookRoutes);
  const form = new FormData();
  form.append('file', new File([PDF], 'paper.pdf', { type: 'application/pdf' }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app.request('/books/upload', { method: 'POST', body: form });
}

describe('clampUploadField', () => {
  it('leaves values within the bound unchanged apart from trimming', () => {
    expect(clampUploadField('  A Title ', 500)).toBe('A Title');
    expect(clampUploadField('a'.repeat(500), 500)).toHaveLength(500);
  });

  it('truncates by code point without splitting a surrogate pair', () => {
    const result = clampUploadField('\u{1F4DA}'.repeat(600), 500);
    expect(Array.from(result)).toHaveLength(500);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('POST /books/upload title/author bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bookService.handleUpload.mockResolvedValue({ remoteId: 'b', catalogId: 'c', jobId: null });
  });

  it('accepts a 778-char author and a 900-char title, clamped to the bounds', async () => {
    const author = Array.from({ length: 40 }, (_, i) => `Researcher Number${i} Lastname`).join(', ');
    expect(author.length).toBeGreaterThan(255);
    const res = await upload({ title: 't'.repeat(900), author, totalPages: '1', mode: 'toc-only' });
    expect(res.status).toBe(200);
    const [, , , , title, sentAuthor, mode] = bookService.handleUpload.mock.calls[0];
    expect(title).toHaveLength(BOOK_CUSTOM_TITLE_MAX);
    expect(sentAuthor).toBe(author.slice(0, BOOK_AUTHOR_MAX).trimEnd());
    expect(mode).toBe('toc-only');
  });

  it('passes short values through unchanged', async () => {
    const res = await upload({ title: 'Short', author: 'Ann Author', totalPages: '3' });
    expect(res.status).toBe(200);
    const [, , , totalPages, title, author, mode] = bookService.handleUpload.mock.calls[0];
    expect([totalPages, title, author, mode]).toEqual([3, 'Short', 'Ann Author', 'full']);
  });

  it('still rejects an invalid mode', async () => {
    const res = await upload({ title: 'Short', mode: 'bogus' });
    expect(res.status).toBe(400);
    expect(bookService.handleUpload).not.toHaveBeenCalled();
  });
});
