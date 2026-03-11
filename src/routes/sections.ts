import { Hono } from 'hono';
import { z } from 'zod';
import { sectionRepository } from '../repositories/section.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { bookService } from '../services/book.service.js';
import { AppError, Errors } from '../lib/errors.js';

export const sectionRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

const createSectionSchema = z.object({
  bookId: z.string().uuid(),
  chapterId: z.string().uuid(),
  title: z.string().min(1),
  startPage: z.coerce.number().int().optional(),
  endPage: z.coerce.number().int().optional(),
  sectionType: z.string().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

const updateSectionSchema = z.object({
  title: z.string().min(1).optional(),
  startPage: z.coerce.number().int().optional(),
  endPage: z.coerce.number().int().optional(),
  isRead: z.boolean().optional(),
  scrollProgress: z.number().min(0).max(1).optional(),
  lastPageViewed: z.coerce.number().int().optional(),
  extractedText: z.string().optional(),
  sectionType: z.string().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

// ─── Helpers ───────────────────────────────────────────────────────

async function verifySectionOwnership(sectionId: string, userId: string) {
  const section = await sectionRepository.findById(sectionId);
  if (!section) throw Errors.notFound('Section');
  // Verify the book belongs to this user
  await bookService.getBook(section.bookId, userId);
  return section;
}

// ─── Routes ────────────────────────────────────────────────────────

sectionRoutes.get('/', async (c) => {
  const user = c.get('user');
  const bookId = c.req.query('bookId');
  const chapterId = c.req.query('chapterId');

  if (!bookId && !chapterId) {
    throw new AppError('VALIDATION_ERROR', 'bookId or chapterId query parameter is required', 400);
  }

  if (bookId) {
    // Verify the book belongs to the user
    await bookService.getBook(bookId, user.id);
    const sections = await sectionRepository.findByBookId(bookId);
    return c.json(sections);
  }

  // chapterId provided — verify ownership through the chapter's book
  const chapter = await chapterRepository.findById(chapterId!);
  if (!chapter) throw Errors.notFound('Chapter');
  await bookService.getBook(chapter.bookId, user.id);
  const sections = await sectionRepository.findByChapterId(chapterId!);
  return c.json(sections);
});

sectionRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const section = await verifySectionOwnership(c.req.param('id'), user.id);
  return c.json(section);
});

sectionRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createSectionSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  // Verify the book belongs to the user
  await bookService.getBook(parsed.data.bookId, user.id);
  const section = await sectionRepository.create(parsed.data);
  return c.json(section, 201);
});

sectionRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = updateSectionSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  await verifySectionOwnership(c.req.param('id'), user.id);
  const section = await sectionRepository.update(c.req.param('id'), parsed.data);
  return c.json(section);
});

sectionRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  await verifySectionOwnership(c.req.param('id'), user.id);
  const section = await sectionRepository.softDelete(c.req.param('id'));
  return c.json(section);
});
