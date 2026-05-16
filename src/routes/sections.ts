import { Hono } from 'hono';
import { z } from 'zod';
import { sectionRepository } from '../repositories/section.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { bookRepository } from '../repositories/book.repository.js';
import { bookService } from '../services/book.service.js';
import { AppError, Errors } from '../lib/errors.js';

export const sectionRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

const createSectionSchema = z
  .object({
    bookId: z.string().uuid(),
    chapterId: z.string().uuid(),
    title: z.string().min(1),
    startPage: z.coerce.number().int().positive().optional(),
    endPage: z.coerce.number().int().positive().optional(),
    sectionType: z.string().optional(),
    sortOrder: z.coerce.number().int().optional(),
  })
  .refine(
    (data) =>
      data.startPage === undefined ||
      data.endPage === undefined ||
      data.startPage <= data.endPage,
    { message: 'Section startPage must be <= endPage' },
  );

const updateSectionSchema = z.object({
  title: z.string().min(1).optional(),
  startPage: z.coerce.number().int().positive().optional(),
  endPage: z.coerce.number().int().positive().optional(),
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
  const book = await bookService.getBook(parsed.data.bookId, user.id);
  // Verify the chapter exists and belongs to the same book (prevents cross-tenant chapterId injection)
  const chapter = await chapterRepository.findById(parsed.data.chapterId);
  if (!chapter || chapter.bookId !== parsed.data.bookId) {
    throw Errors.notFound('Chapter');
  }
  // Enforce page numbers stay within the parent book's total page count
  if (parsed.data.startPage !== undefined || parsed.data.endPage !== undefined) {
    const catalog = await bookRepository.findCatalogById(book.catalogId);
    const totalPages = catalog?.totalPages;
    if (totalPages && totalPages > 0) {
      if (parsed.data.startPage !== undefined && parsed.data.startPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Section startPage (${parsed.data.startPage}) exceeds total pages (${totalPages})`, 400);
      }
      if (parsed.data.endPage !== undefined && parsed.data.endPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Section endPage (${parsed.data.endPage}) exceeds total pages (${totalPages})`, 400);
      }
    }
  }
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
  const existing = await verifySectionOwnership(c.req.param('id'), user.id);
  // Cross-field + totalPages checks only when page bounds are being touched.
  // Merge with the existing row so a PUT setting just one side still validates.
  if (parsed.data.startPage !== undefined || parsed.data.endPage !== undefined) {
    const effectiveStart = parsed.data.startPage ?? existing.startPage ?? undefined;
    const effectiveEnd = parsed.data.endPage ?? existing.endPage ?? undefined;
    if (effectiveStart !== undefined && effectiveEnd !== undefined && effectiveStart > effectiveEnd) {
      throw new AppError('VALIDATION_ERROR', 'Section startPage must be <= endPage', 400);
    }
    const book = await bookService.getBook(existing.bookId, user.id);
    const catalog = await bookRepository.findCatalogById(book.catalogId);
    const totalPages = catalog?.totalPages;
    if (totalPages && totalPages > 0) {
      if (parsed.data.startPage !== undefined && parsed.data.startPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Section startPage (${parsed.data.startPage}) exceeds total pages (${totalPages})`, 400);
      }
      if (parsed.data.endPage !== undefined && parsed.data.endPage > totalPages) {
        throw new AppError('VALIDATION_ERROR', `Section endPage (${parsed.data.endPage}) exceeds total pages (${totalPages})`, 400);
      }
    }
  }
  const section = await sectionRepository.update(c.req.param('id'), parsed.data);
  return c.json(section);
});

sectionRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  await verifySectionOwnership(c.req.param('id'), user.id);
  const section = await sectionRepository.softDelete(c.req.param('id'));
  return c.json(section);
});
