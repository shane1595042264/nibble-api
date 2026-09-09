import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// idx_books_user_catalog spans soft-deleted rows, so add-to-shelf has to take a
// restore branch after a delete instead of inserting into an occupied slot (KAN-295).
const bookRepo = vi.hoisted(() => ({
  findCatalogById: vi.fn(),
  findByUserIdAndCatalogId: vi.fn(),
  findDeletedByUserIdAndCatalogId: vi.fn(),
  restore: vi.fn(),
  create: vi.fn(),
  incrementCatalogUserCount: vi.fn(),
}));
vi.mock('../../../src/repositories/book.repository.js', () => ({ bookRepository: bookRepo }));

// admin.ts pulls these in at module scope; the add-to-shelf handler touches none of them.
vi.mock('../../../src/db/index.js', () => ({ db: {} }));
vi.mock('../../../src/repositories/billing.repository.js', () => ({ billingRepository: {} }));
vi.mock('../../../src/repositories/user.repository.js', () => ({ userRepository: {} }));
vi.mock('../../../src/jobs/cleanup.js', () => ({ reclaimCatalogStorage: vi.fn() }));

const { adminRoutes } = await import('../../../src/routes/admin.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CATALOG_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';

function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  // Mirrors src/index.ts, where authMiddleware sets the user before /admin/*.
  app.use('/admin/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const addToShelf = () =>
  makeApp().request(`/admin/catalog/${CATALOG_ID}/add-to-shelf`, { method: 'POST' });

describe('POST /admin/catalog/:id/add-to-shelf', () => {
  beforeEach(() => {
    for (const fn of Object.values(bookRepo)) fn.mockReset();
    bookRepo.findCatalogById.mockResolvedValue({ id: CATALOG_ID, userCount: 3 });
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue(null);
    bookRepo.findDeletedByUserIdAndCatalogId.mockResolvedValue(null);
    bookRepo.incrementCatalogUserCount.mockResolvedValue(undefined);
  });

  it('restores the soft-deleted row instead of inserting into its occupied unique slot', async () => {
    bookRepo.findDeletedByUserIdAndCatalogId.mockResolvedValue({ id: BOOK_ID, deletedAt: new Date() });
    bookRepo.restore.mockResolvedValue({ id: BOOK_ID, deletedAt: null, processingStatus: 'complete' });

    const res = await addToShelf();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      book: { id: BOOK_ID, deletedAt: null },
      restored: true,
      alreadyExists: false,
    });

    // The INSERT that used to raise 23505 must not run at all.
    expect(bookRepo.create).not.toHaveBeenCalled();
    expect(bookRepo.restore).toHaveBeenCalledWith(BOOK_ID, { processingStatus: 'complete' });
  });

  it('does not count a restore as a new adopter', async () => {
    bookRepo.findDeletedByUserIdAndCatalogId.mockResolvedValue({ id: BOOK_ID });
    bookRepo.restore.mockResolvedValue({ id: BOOK_ID, deletedAt: null });

    await addToShelf();
    expect(bookRepo.incrementCatalogUserCount).not.toHaveBeenCalled();
  });

  it('surfaces a lost restore as a 409, never as { book: null }', async () => {
    bookRepo.findDeletedByUserIdAndCatalogId.mockResolvedValue({ id: BOOK_ID });
    bookRepo.restore.mockResolvedValue(null); // UPDATE ... returning() matched nothing

    const res = await addToShelf();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('bumps the catalog adoption count on a genuinely new add', async () => {
    bookRepo.create.mockResolvedValue({ id: BOOK_ID, processingStatus: 'complete' });

    const res = await addToShelf();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ book: { id: BOOK_ID }, alreadyExists: false });
    expect(bookRepo.incrementCatalogUserCount).toHaveBeenCalledWith(CATALOG_ID);
  });

  it('is idempotent on an active row and leaves the count alone', async () => {
    bookRepo.findByUserIdAndCatalogId.mockResolvedValue({ id: BOOK_ID });

    const res = await addToShelf();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyExists: true });
    expect(bookRepo.create).not.toHaveBeenCalled();
    expect(bookRepo.incrementCatalogUserCount).not.toHaveBeenCalled();
  });

  it('answers a lost insert race from the winning row rather than 500ing', async () => {
    bookRepo.create.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    // The concurrent request's row is visible by the time we re-read.
    bookRepo.findByUserIdAndCatalogId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: BOOK_ID });

    const res = await addToShelf();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ book: { id: BOOK_ID }, alreadyExists: true });
  });

  it('raises a legible 409 when a 23505 has no visible winning row', async () => {
    bookRepo.create.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const res = await addToShelf();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('still propagates non-unique driver errors', async () => {
    bookRepo.create.mockRejectedValue(Object.assign(new Error('fk violation'), { code: '23503' }));
    // errorHandler logs the unexpected error; that trace is the point, not noise to assert on.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await addToShelf();
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
