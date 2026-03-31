import { Hono } from 'hono';
import { z } from 'zod';
import { bookService } from '../services/book.service.js';
import { AppError } from '../lib/errors.js';
import { config } from '../lib/config.js';

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

  // Validate file type (PDF only) — check MIME type first
  if (file.type !== 'application/pdf') {
    return c.json({ error: 'Only PDF files are allowed' }, 400);
  }

  // Validate file size before loading into memory
  const maxBytes = config.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    return c.json({ error: `File size exceeds the ${config.MAX_UPLOAD_SIZE_MB}MB limit` }, 413);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Validate PDF magic bytes (%PDF header)
  if (buffer.length < 4 || buffer[0] !== 0x25 || buffer[1] !== 0x50 || buffer[2] !== 0x44 || buffer[3] !== 0x46) {
    return c.json({ error: 'Only PDF files are allowed' }, 400);
  }
  const { sha256 } = await import('../lib/hash.js');
  const fileHash = sha256(buffer);

  const title = (formData.get('title') as string) || file.name.replace('.pdf', '');
  const author = formData.get('author') as string | undefined;
  const totalPages = parseInt((formData.get('totalPages') as string) || '0');
  const mode = (formData.get('mode') as string) || 'full'; // 'full' | 'toc-only'

  const user = c.get('user');
  const result = await bookService.handleUpload(user.id, fileHash, buffer, totalPages, title, author, mode);
  return c.json({ ...result, jobId: result.jobId });
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

// GET /:id/download — download PDF from R2
bookRoutes.get('/:id/download', async (c) => {
  const user = c.get('user');
  const book = await bookService.getBook(c.req.param('id'), user.id);

  const { bookRepository } = await import('../repositories/book.repository.js');
  const catalog = await bookRepository.findCatalogById(book.catalogId);
  if (!catalog) throw new AppError('NOT_FOUND', 'Catalog entry not found', 404);

  const { db } = await import('../db/index.js');
  const { pdfFiles } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [pdfFile] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, catalog.fileHash)).limit(1);
  if (!pdfFile) throw new AppError('NOT_FOUND', 'PDF file not found', 404);

  const { storageService } = await import('../services/storage.service.js');
  const buffer = await storageService.downloadPdf(pdfFile.r2Key);

  c.header('Content-Type', 'application/pdf');
  c.header('Content-Disposition', `attachment; filename="${catalog.title || 'book'}.pdf"`);
  return c.body(new Uint8Array(buffer));
});

// GET /:id/summary — get book with catalog info for sync
bookRoutes.get('/:id/summary', async (c) => {
  const user = c.get('user');
  const book = await bookService.getBook(c.req.param('id'), user.id);
  const { bookRepository } = await import('../repositories/book.repository.js');
  const catalog = await bookRepository.findCatalogById(book.catalogId);
  return c.json({ book, catalog });
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

// ─── Smart Split: Structure endpoints ─────────────────────────────

const structureSchema = z.object({
  chapters: z.array(z.object({
    title: z.string(),
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
    sections: z.array(z.object({
      title: z.string(),
      startPage: z.number().int().positive(),
      endPage: z.number().int().positive(),
    })).optional(),
  })),
});

const suggestStructureSchema = z.object({
  tocPages: z.array(z.number().int().positive()).min(1),
});

// PUT /:id/structure — replace entire chapter/section structure
bookRoutes.put('/:id/structure', async (c) => {
  const user = c.get('user');
  const bookId = c.req.param('id');
  const book = await bookService.getBook(bookId, user.id);

  const body = await c.req.json();
  const parsed = structureSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }

  const { db } = await import('../db/index.js');
  const { chapters, sections } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { chapterRepository } = await import('../repositories/chapter.repository.js');
  const { sectionRepository } = await import('../repositories/section.repository.js');

  // Save old sections for progress preservation
  const oldSections = await sectionRepository.findByBookId(book.id);

  // Delete existing structure
  await db.delete(sections).where(eq(sections.bookId, book.id));
  await db.delete(chapters).where(eq(chapters.bookId, book.id));

  // Create new structure
  const newChapters = [];
  const newSections = [];
  let sectionOrder = 0;

  for (let ci = 0; ci < parsed.data.chapters.length; ci++) {
    const ch = parsed.data.chapters[ci];

    const chapter = await chapterRepository.create({
      bookId: book.id,
      title: ch.title,
      startPage: ch.startPage,
      endPage: ch.endPage,
      sortOrder: ci,
    });
    newChapters.push(chapter);

    const chapterSections = ch.sections && ch.sections.length > 0
      ? ch.sections
      : [{ title: ch.title, startPage: ch.startPage, endPage: ch.endPage }];

    for (const sec of chapterSections) {
      // Progress preservation: check if new section overlaps >50% with an old read section
      let isRead = false;
      const newRange = sec.endPage - sec.startPage + 1;
      for (const oldSec of oldSections) {
        if (!oldSec.isRead || oldSec.startPage == null || oldSec.endPage == null) continue;
        const overlapStart = Math.max(sec.startPage, oldSec.startPage);
        const overlapEnd = Math.min(sec.endPage, oldSec.endPage);
        const overlap = Math.max(0, overlapEnd - overlapStart + 1);
        if (overlap / newRange > 0.5) {
          isRead = true;
          break;
        }
      }

      const section = await sectionRepository.create({
        bookId: book.id,
        chapterId: chapter.id,
        title: sec.title,
        startPage: sec.startPage,
        endPage: sec.endPage,
        sectionType: 'content',
        sortOrder: ++sectionOrder,
        isRead,
        readAt: isRead ? new Date() : undefined,
      });
      newSections.push(section);
    }
  }

  // Update book structure source
  const { bookRepository } = await import('../repositories/book.repository.js');
  await bookRepository.update(book.id, { structureSource: 'manual' });

  return c.json({ chapters: newChapters, sections: newSections });
});

// POST /:id/suggest-structure — use Claude Vision to parse TOC pages
bookRoutes.post('/:id/suggest-structure', async (c) => {
  const user = c.get('user');
  const bookId = c.req.param('id');
  const book = await bookService.getBook(bookId, user.id);

  const body = await c.req.json();
  const parsed = suggestStructureSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }

  const { bookRepository } = await import('../repositories/book.repository.js');
  const catalog = await bookRepository.findCatalogById(book.catalogId);
  if (!catalog) throw new AppError('NOT_FOUND', 'Catalog entry not found', 404);

  const { db } = await import('../db/index.js');
  const { pdfFiles } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [pdfFile] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, catalog.fileHash)).limit(1);
  if (!pdfFile) throw new AppError('NOT_FOUND', 'PDF file not found', 404);

  const { storageService } = await import('../services/storage.service.js');
  const pdfBuffer = await storageService.downloadPdf(pdfFile.r2Key);

  const { pdfService } = await import('../services/pdf.service.js');
  const doc = await pdfService.loadDocument(pdfBuffer);

  try {
    // Try rendering TOC pages as images; fall back to text extraction
    let useImages = true;
    const tocContent: Array<{ type: 'image'; data: string; mediaType: string } | { type: 'text'; text: string }> = [];

    for (const pageNum of parsed.data.tocPages) {
      try {
        const imageBuffer = await pdfService.renderPageToImageFromDoc(doc, pageNum, 2.0);
        tocContent.push({
          type: 'image',
          data: imageBuffer.toString('base64'),
          mediaType: 'image/png',
        });
      } catch {
        // node-canvas failed — fall back to text for all pages
        useImages = false;
        break;
      }
    }

    // If image rendering failed, extract text instead
    if (!useImages) {
      tocContent.length = 0;
      for (const pageNum of parsed.data.tocPages) {
        const text = await pdfService.extractPageTextFromDoc(doc, pageNum);
        tocContent.push({ type: 'text', text: `--- Page ${pageNum} ---\n${text}` });
      }
    }

    // Build Claude prompt
    const systemPrompt = `You are an expert at parsing book tables of contents. Extract the chapter/section structure from the provided TOC page(s).

Return a JSON object with this exact format:
{
  "chapters": [
    {
      "title": "Chapter Title",
      "startPage": 1,
      "endPage": 15,
      "sections": [
        { "title": "Section Title", "startPage": 1, "endPage": 5 }
      ]
    }
  ]
}

Rules:
- Use the page numbers shown in the TOC
- If a chapter has no sub-sections, omit the "sections" field
- For nested structures (Part > Chapter > Section), use ">" prefix notation for the chapter title (e.g. "Part 1 > Chapter 1")
- Ensure endPage of one chapter/section is one less than startPage of the next
- Return ONLY valid JSON, no markdown fences or commentary`;

    const userContent: Array<any> = [];

    // 2-shot examples
    userContent.push({
      type: 'text',
      text: `Example 1 input: A TOC showing "Chapter 1: Intro ..... 1" and "Chapter 2: Methods ..... 15"
Example 1 output: {"chapters":[{"title":"Chapter 1: Intro","startPage":1,"endPage":14},{"title":"Chapter 2: Methods","startPage":15,"endPage":30}]}

Example 2 input: A TOC showing "Part I" with "1. Basics ... 3" and "2. Advanced ... 20" under it
Example 2 output: {"chapters":[{"title":"Part I > 1. Basics","startPage":3,"endPage":19},{"title":"Part I > 2. Advanced","startPage":20,"endPage":40}]}

Now parse the following TOC:`,
    });

    for (const item of tocContent) {
      if (item.type === 'image') {
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: item.mediaType,
            data: item.data,
          },
        });
      } else {
        userContent.push({ type: 'text', text: item.text });
      }
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 30_000 });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new AppError('AI_ERROR', 'No text response from Claude', 502);
    }

    // Parse JSON from response (handle possible markdown fences)
    let jsonStr = textBlock.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const suggestions = JSON.parse(jsonStr) as {
      chapters: Array<{
        title: string;
        startPage: number;
        endPage: number;
        sections?: Array<{ title: string; startPage: number; endPage: number }>;
      }>;
    };

    // Flatten nested structure using > prefix for chapter accordion display
    const flatChapters: Array<{ title: string; startPage: number; endPage: number }> = [];
    for (const ch of suggestions.chapters) {
      if (ch.sections && ch.sections.length > 0) {
        for (const sec of ch.sections) {
          flatChapters.push({
            title: `${ch.title} > ${sec.title}`,
            startPage: sec.startPage,
            endPage: sec.endPage,
          });
        }
      } else {
        flatChapters.push({
          title: ch.title,
          startPage: ch.startPage,
          endPage: ch.endPage,
        });
      }
    }

    return c.json({ suggestions, flatChapters });
  } finally {
    await doc.destroy().catch(() => {});
  }
});
