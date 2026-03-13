import { Hono } from 'hono';
import { z } from 'zod';
import { bookService } from '../services/book.service.js';
import { AppError } from '../lib/errors.js';

export const bookRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

const createBookSchema = z.object({
  catalogId: z.string().uuid(),
  customTitle: z.string().optional(),
  coverUrl: z.string().url().optional(),
});

const updateBookSchema = z.object({
  customTitle: z.string().optional(),
  coverUrl: z.string().url().optional(),
  structureSource: z.string().optional(),
  processingStatus: z.string().optional(),
  lastReadAt: z.string().datetime().optional(),
  lastAccessedSectionId: z.string().uuid().optional(),
  lastAccessedScrollProgress: z.number().min(0).max(1).optional(),
  lastAccessedWordIndex: z.coerce.number().int().optional(),
});

// ─── Routes ────────────────────────────────────────────────────────

// POST /match — check hash + fuzzy title match
bookRoutes.post('/match', async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    fileHash: z.string(),
    title: z.string().optional(),
  });
  const { fileHash, title } = schema.parse(body);
  const result = await bookService.matchBook(fileHash, title);
  return c.json(result);
});

// POST /upload — upload PDF
bookRoutes.post('/upload', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File;
  if (!file) return c.json({ error: 'No file provided' }, 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  const { sha256 } = await import('../lib/hash.js');
  const fileHash = sha256(buffer);

  const title = (formData.get('title') as string) || file.name.replace('.pdf', '');
  const author = formData.get('author') as string | undefined;
  const totalPages = parseInt((formData.get('totalPages') as string) || '0');

  const user = c.get('user');
  const result = await bookService.handleUpload(user.id, fileHash, buffer, totalPages, title, author);
  return c.json(result);
});

bookRoutes.get('/', async (c) => {
  const user = c.get('user');
  const books = await bookService.listBooks(user.id);
  return c.json(books);
});

bookRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const book = await bookService.getBook(c.req.param('id'), user.id);
  return c.json(book);
});

bookRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createBookSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const book = await bookService.createBook(user.id, parsed.data);
  return c.json(book, 201);
});

bookRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = updateBookSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const book = await bookService.updateBook(c.req.param('id'), user.id, parsed.data);
  return c.json(book);
});

bookRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const book = await bookService.deleteBook(c.req.param('id'), user.id);
  return c.json(book);
});

// PUT /:id/metadata — update catalog metadata (title, author, etc.)
const updateMetadataSchema = z.object({
  title: z.string().min(1).optional(),
  author: z.string().optional(),
  description: z.string().optional(),
  coverUrl: z.string().url().optional().nullable(),
  language: z.string().optional(),
  publisher: z.string().optional(),
  publishYear: z.number().int().optional().nullable(),
});

bookRoutes.put('/:id/metadata', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = updateMetadataSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const result = await bookService.updateBookMetadata(c.req.param('id'), user.id, parsed.data);
  return c.json(result);
});
