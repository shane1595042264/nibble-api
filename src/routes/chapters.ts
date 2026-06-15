import { Hono } from 'hono';
import { z } from 'zod';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { bookRepository } from '../repositories/book.repository.js';
import { bookService } from '../services/book.service.js';
import { AppError, Errors } from '../lib/errors.js';

export const chapterRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

// Bounds match the smart-split structureSchema in books.ts (title .max(500)).
// Page-range rules mirror createSectionSchema in sections.ts: positive ints,
// and startPage <= endPage when both are provided.
export const createChapterSchema = z
  .object({
    bookId: z.string().uuid(),
    title: z.string().min(1).max(500),
    startPage: z.coerce.number().int().positive().optional(),
    endPage: z.coerce.number().int().positive().optional(),
    sortOrder: z.coerce.number().int().optional(),
  })
  .refine(
    (data) =>
      data.startPage === undefined ||
      data.endPage === undefined ||
      data.startPage <= data.endPage,
    { message: 'Chapter startPage must be <= endPage' },
  );

export const updateChapterSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  startPage: z.coerce.number().int().positive().optional(),
  endPage: z.coerce.number().int().positive().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

// ─── Helpers ───────────────────────────────────────────────────────

async function verifyChapterOwnership(chapterId: string, userId: string) {
  const chapter = await chapterRepository.findById(chapterId);
  if (!chapter) throw Errors.notFound('Chapter');
  // Verify the book belongs to this user
  await bookService.getBook(chapter.bookId, userId);
  return chapter;
}

// ─── Routes ────────────────────────────────────────────────────────

chapterRoutes.get('/', async (c) => {
  const user = c.get('user');
  const bookId = c.req.query('bookId');
  if (!bookId) {
    throw new AppError('VALIDATION_ERROR', 'bookId query parameter is required', 400);
  }
  // Verify the book belongs to the user
  await bookService.getBook(bookId, user.id);
  const chapters = await chapterRepository.findByBookId(bookId);
  return c.json(chapters);
});

chapterRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const chapter = await verifyChapterOwnership(c.req.param('id'), user.id);
  return c.json(chapter);
});

chapterRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createChapterSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  // Verify the book belongs to the user
  const book = await bookService.getBook(parsed.data.bookId, user.id);
  // Enforce page numbers stay within the parent book's total page count
  if (parsed.data.startPage !== undefined || parsed.data.endPage !== undefined) {
    const catalog = await bookRepository.findCatalogById(book.catalogId);
    const totalPages = catalog?.totalPages;
    if (totalPages && totalPages > 0) {
      if (parsed.data.startPage !== undefined && parsed.data.startPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Chapter startPage (${parsed.data.startPage}) exceeds total pages (${totalPages})`, 400);
      }
      if (parsed.data.endPage !== undefined && parsed.data.endPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Chapter endPage (${parsed.data.endPage}) exceeds total pages (${totalPages})`, 400);
      }
    }
  }
  const chapter = await chapterRepository.create(parsed.data);
  return c.json(chapter, 201);
});

chapterRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = updateChapterSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const existing = await verifyChapterOwnership(c.req.param('id'), user.id);
  // Cross-field + totalPages checks only when page bounds are being touched.
  // Merge with the existing row so a PUT setting just one side still validates.
  if (parsed.data.startPage !== undefined || parsed.data.endPage !== undefined) {
    const effectiveStart = parsed.data.startPage ?? existing.startPage ?? undefined;
    const effectiveEnd = parsed.data.endPage ?? existing.endPage ?? undefined;
    if (effectiveStart !== undefined && effectiveEnd !== undefined && effectiveStart > effectiveEnd) {
      throw new AppError('VALIDATION_ERROR', 'Chapter startPage must be <= endPage', 400);
    }
    const book = await bookService.getBook(existing.bookId, user.id);
    const catalog = await bookRepository.findCatalogById(book.catalogId);
    const totalPages = catalog?.totalPages;
    if (totalPages && totalPages > 0) {
      if (parsed.data.startPage !== undefined && parsed.data.startPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Chapter startPage (${parsed.data.startPage}) exceeds total pages (${totalPages})`, 400);
      }
      if (parsed.data.endPage !== undefined && parsed.data.endPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Chapter endPage (${parsed.data.endPage}) exceeds total pages (${totalPages})`, 400);
      }
    }
  }
  const chapter = await chapterRepository.update(c.req.param('id'), parsed.data);
  return c.json(chapter);
});

chapterRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  await verifyChapterOwnership(c.req.param('id'), user.id);
  const chapter = await chapterRepository.softDelete(c.req.param('id'));
  return c.json(chapter);
});
