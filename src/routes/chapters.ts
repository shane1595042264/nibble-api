import { Hono } from 'hono';
import { z } from 'zod';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { bookService } from '../services/book.service.js';
import { AppError, Errors } from '../lib/errors.js';

export const chapterRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

// Bounds match the smart-split structureSchema in books.ts (title .max(500)).
export const createChapterSchema = z.object({
  bookId: z.string().uuid(),
  title: z.string().min(1).max(500),
  startPage: z.coerce.number().int().optional(),
  endPage: z.coerce.number().int().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export const updateChapterSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  startPage: z.coerce.number().int().optional(),
  endPage: z.coerce.number().int().optional(),
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
  await bookService.getBook(parsed.data.bookId, user.id);
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
  await verifyChapterOwnership(c.req.param('id'), user.id);
  const chapter = await chapterRepository.update(c.req.param('id'), parsed.data);
  return c.json(chapter);
});

chapterRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  await verifyChapterOwnership(c.req.param('id'), user.id);
  const chapter = await chapterRepository.softDelete(c.req.param('id'));
  return c.json(chapter);
});
