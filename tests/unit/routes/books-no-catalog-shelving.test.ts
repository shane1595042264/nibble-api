import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// POST /books/match listed other users' catalog rows by fuzzy title, POST /books
// shelved any catalogId without the file bytes, and GET /books/:id/download then
// streamed that user's private upload. Neither route had a client caller, so both
// are gone (KAN-390). Every service method throws so a surviving route fails loudly.
const bookService = vi.hoisted(() =>
  new Proxy({}, { get: (_t, name) => vi.fn(() => { throw new Error(`bookService.${String(name)} reached`); }) }),
);
vi.mock('../../../src/services/book.service.js', () => ({ bookService }));

const { bookRoutes } = await import('../../../src/routes/books.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeApp() {
  const app = new Hono();
  app.use('/books/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/books', bookRoutes);
  return app;
}

const postJson = (path: string, body: unknown) =>
  makeApp().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('books routes: no catalog lookup or shelving by catalogId (KAN-390)', () => {
  it('POST /books/match is not routed', async () => {
    const res = await postJson('/books/match', { fileHash: 'x', title: 'the' });
    expect(res.status).toBe(404);
  });

  it('POST /books {catalogId} is not routed', async () => {
    const res = await postJson('/books', { catalogId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(404);
  });
});
