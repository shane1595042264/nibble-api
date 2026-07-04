import { storageService } from './storage.service.js';
import { pdfService } from './pdf.service.js';
import type { OutlineItem } from './pdf.service.js';
import { parseEpub } from './epub.service.js';
import { bookRepository } from '../repositories/book.repository.js';
import { processingLogRepository } from '../repositories/processing-log.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { sectionRepository } from '../repositories/section.repository.js';
import { NibParser } from '../lib/nib/parser.js';
import { NibDocument } from '../lib/nib/models.js';
import { db } from '../db/index.js';
import { pdfFiles, sections, chapters, bookCatalog, books } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const parser = new NibParser();

/**
 * Reliably mark a book as processingStatus:'error' on a pipeline failure.
 *
 * This is the *only* place the pipelines set the book to 'error' — the internal
 * catch never rethrows, so the caller-level nets (book.service startPipelineAsync,
 * processing.ts retry route) never run for a pipeline-internal failure. A silently
 * swallowed write here (the former `.catch(() => {})`) would leave the book stuck
 * showing 'processing' forever with no error/Retry affordance (KAN-243).
 *
 * So: retry a couple times to ride out the transient DB blip that's plausible
 * precisely when the pipeline just failed (pool exhaustion / connection drop /
 * timeout), and if it STILL fails, log loudly so ops can see the stuck book
 * instead of discarding the failure.
 */
export async function markBookErrored(bookId: string, jobId: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await bookRepository.update(bookId, { processingStatus: 'error' });
      return;
    } catch (err: any) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(
          `[processing] CRITICAL: failed to set book ${bookId} to 'error' after ${MAX_ATTEMPTS} attempts (job ${jobId}). Book may be stuck showing 'processing' — manual intervention required.`,
          err,
        );
        return;
      }
      // Short linear backoff before retrying the status write.
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

export const processingService = {
  /**
   * Dispatch the right per-format pipeline based on the book's catalog format.
   * PDFs run the full 8-stage pipeline; EPUBs run a much simpler pipeline
   * (unzip + parse OPF/XHTML + extract plain text + insert sections).
   */
  async orchestratePipeline(jobId: string, fileHash: string, bookId: string, mode: string = 'full'): Promise<void> {
    // Look up the catalog to decide which pipeline to run.
    const catalog = await bookRepository.findCatalogByHash(fileHash);
    if (catalog?.format === 'epub') {
      return orchestrateEpubPipeline(jobId, fileHash, bookId);
    }
    return orchestratePdfPipeline(jobId, fileHash, bookId, mode);
  },

  /** Cancel a processing job */
  async cancelJob(jobId: string): Promise<void> {
    await processingLogRepository.append(jobId, 'cancel', 'Processing cancelled by user');
    await processingLogRepository.failJob(jobId, 'Cancelled by user');
    const job = await processingLogRepository.getJob(jobId);
    if (job?.bookId) {
      // Clean up: delete chapters/sections created during processing, reset book status
      await db.delete(sections).where(eq(sections.bookId, job.bookId));
      await db.delete(chapters).where(eq(chapters.bookId, job.bookId));
      await bookRepository.update(job.bookId, { processingStatus: 'error' });
    }
  },
};

/**
 * Original PDF pipeline — 8 stages (download, metadata, toc, structure,
 * text extraction, Mathpix, OCR, cover + finalize). Unchanged by the EPUB
 * feature beyond being extracted from orchestratePipeline as a private fn.
 */
async function orchestratePdfPipeline(jobId: string, fileHash: string, bookId: string, mode: string = 'full'): Promise<void> {
    try {
      // ── Stage 1: Download PDF (0-5%) ──────────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 0, 'download');
      await processingLogRepository.append(jobId, 'download', 'Downloading PDF from storage...');

      const [pdfFile] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, fileHash)).limit(1);
      if (!pdfFile) throw new Error('PDF file not found in storage');

      const pdfBuffer = await storageService.downloadPdf(pdfFile.r2Key);
      await processingLogRepository.updateJobProgress(jobId, 5, 'download');
      await processingLogRepository.append(jobId, 'download', `PDF downloaded (${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

      // ── Stage 2: Extract metadata (5-10%) ─────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 5, 'metadata');
      await processingLogRepository.append(jobId, 'metadata', 'Extracting PDF metadata...');

      // Load document ONCE and reuse for all stages
      const doc = await pdfService.loadDocument(pdfBuffer);
      const totalPages = doc.numPages;

      let metadataTitle = 'unknown';
      let metadataAuthor = 'unknown';
      try {
        const meta = await doc.getMetadata();
        const info = meta?.info as any;
        metadataTitle = info?.Title || 'unknown';
        metadataAuthor = info?.Author || 'unknown';
      } catch (err: any) {
        await processingLogRepository.append(
          jobId, 'metadata',
          `getMetadata() threw: ${err?.message ?? String(err)} — falling back to title="unknown", author="unknown"`,
          'warn',
        );
      }

      await processingLogRepository.append(
        jobId, 'metadata',
        `Metadata extracted: ${totalPages} pages, title="${metadataTitle}", author="${metadataAuthor}"`,
      );
      await processingLogRepository.updateJobProgress(jobId, 10, 'metadata');

      // ── Stage 3: Parse TOC (10-15%) ───────────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 10, 'toc');
      await processingLogRepository.append(jobId, 'toc', 'Extracting table of contents...');

      const outline = await pdfService.extractOutlineFromDoc(doc);
      const hasToc = outline !== null && outline.length > 0;

      await processingLogRepository.append(
        jobId, 'toc',
        hasToc
          ? `TOC found with ${outline.length} top-level entries`
          : 'No TOC found — will use batch structure',
      );
      await processingLogRepository.updateJobProgress(jobId, 15, 'toc');

      // ── Stage 4: Build structure (15-20%) ─────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 15, 'structure');
      await processingLogRepository.append(jobId, 'structure', 'Building chapter/section structure...');

      if (hasToc && outline) {
        await buildStructureFromOutline(jobId, bookId, pdfBuffer, outline, totalPages);
      } else {
        await buildBatchStructure(jobId, bookId, totalPages);
      }

      await processingLogRepository.updateJobProgress(jobId, 20, 'structure');
      await processingLogRepository.append(jobId, 'structure', 'Structure built successfully');

      // ── Stage 5: Extract text (20-80%) ────────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 20, 'text_extraction');
      await processingLogRepository.append(jobId, 'text_extraction', 'Starting text extraction...');

      const allSections = await sectionRepository.findByBookId(bookId);
      const totalSections = allSections.length;

      for (let i = 0; i < totalSections; i++) {
        const section = allSections[i];
        const startPage = section.startPage ?? 1;
        const endPage = section.endPage ?? startPage;

        // Mirror frontend's NibService.getCleanText():
        // 1. Extract rich page range (with font resolution)
        // 2. Parse entire range with NibParser.parseDocument() (handles cross-page paragraphs)
        // 3. Get NibDocument.fullText (headers/footers/footnotes removed)
        let sectionText: string | null = null;
        try {
          const rawPages = await pdfService.extractRichPageRangeFromDoc(doc, startPage, endPage);
          const docData = parser.parseDocument(rawPages, metadataTitle, metadataAuthor);
          const nibDoc = NibDocument.fromData(docData);
          sectionText = nibDoc.fullText.trim() || null;
        } catch (err: any) {
          await processingLogRepository.append(
            jobId, 'text_extraction',
            `NibParser failed for section "${section.title}": ${err.message}, trying raw extraction`,
            'warn',
          );
          // Fallback: raw text extraction (same as frontend fallback)
          try {
            const pageTexts: string[] = [];
            for (let p = startPage; p <= endPage; p++) {
              const text = await pdfService.extractPageTextFromDoc(doc, p);
              if (text.trim()) pageTexts.push(text);
            }
            sectionText = pageTexts.join('\n\n') || null;
          } catch {
            // Page has no extractable text
          }
        }

        if (sectionText) {
          await sectionRepository.update(section.id, { extractedText: sectionText });
        }

        const progress = Math.round(20 + ((i + 1) / totalSections) * 60);
        await processingLogRepository.updateJobProgress(jobId, progress, 'text_extraction');

        if ((i + 1) % 5 === 0 || i === totalSections - 1) {
          await processingLogRepository.append(
            jobId, 'text_extraction',
            `Extracted text for ${i + 1}/${totalSections} sections`,
          );
        }
      }

      // ── Stage 5b: Mathpix rich content (skip in toc-only mode) ──────
      if (mode === 'toc-only') {
        await processingLogRepository.append(jobId, 'mathpix', 'TOC-only mode — skipping Mathpix');
        await processingLogRepository.updateJobProgress(jobId, 80, 'mathpix');
      } else {
      const { mathpixService } = await import('./mathpix.service.js');
      if (mathpixService.isConfigured()) {
        await processingLogRepository.updateJobProgress(jobId, 75, 'mathpix');

        try {
          // Cherry-pick: only send pages that likely contain tables or formulas
          const sectionsForMathpix = await sectionRepository.findByBookId(bookId);

          // Patterns that indicate rich content needing Mathpix
          const richContentPattern = /\$.*\$|\\frac|\\sum|\\int|\\sqrt|\\begin\{|\\end\{|\|[-+|]+\||[│┃┆┊]|^\s*[-|]+\s*$/m;
          const tableHeaderPattern = /(\t.*){2,}|(\s{2,}\S+){3,}/m;

          // Collect unique page numbers that need Mathpix processing
          const pagesNeedingMathpix = new Set<number>();
          for (const section of sectionsForMathpix) {
            const text = section.extractedText ?? '';
            if (richContentPattern.test(text) || tableHeaderPattern.test(text)) {
              const startPage = section.startPage ?? 1;
              const endPage = section.endPage ?? startPage;
              for (let p = startPage; p <= endPage; p++) {
                pagesNeedingMathpix.add(p);
              }
            }
          }

          const sortedPages = Array.from(pagesNeedingMathpix).sort((a, b) => a - b);
          await processingLogRepository.append(
            jobId, 'mathpix',
            `Cherry-picked ${sortedPages.length} of ${totalPages} pages for Mathpix (tables/formulas detected)`,
          );

          if (sortedPages.length === 0) {
            await processingLogRepository.append(jobId, 'mathpix', 'No pages with tables/formulas detected — skipping Mathpix');
          } else {
            // Process cherry-picked pages via per-page image API (5 concurrent)
            const pageMarkdown = new Map<number, string>(); // page number → markdown
            const CONCURRENCY = 5;

            for (let i = 0; i < sortedPages.length; i += CONCURRENCY) {
              const batch = sortedPages.slice(i, i + CONCURRENCY);
              const results = await Promise.all(
                batch.map(async (pageNum) => {
                  try {
                    const imageBuffer = await pdfService.renderPageToImageFromDoc(doc, pageNum, 2.0);
                    const md = await mathpixService.convertPageToMarkdown(imageBuffer);
                    return { pageNum, md };
                  } catch (err: any) {
                    await processingLogRepository.append(
                      jobId, 'mathpix',
                      `Warning: Mathpix failed for page ${pageNum}: ${err.message}`,
                      'warn',
                    );
                    return { pageNum, md: '' };
                  }
                }),
              );
              for (const { pageNum, md } of results) {
                if (md.trim()) pageMarkdown.set(pageNum, md);
              }

              // Progress: 75-80% range
              const progress = Math.round(75 + ((i + batch.length) / sortedPages.length) * 5);
              await processingLogRepository.updateJobProgress(jobId, progress, 'mathpix');
            }

            await processingLogRepository.append(jobId, 'mathpix', `Mathpix returned content for ${pageMarkdown.size} pages`);

            // Map per-page markdown to sections
            let mathpixCount = 0;
            for (const section of sectionsForMathpix) {
              const startPage = section.startPage ?? 1;
              const endPage = section.endPage ?? startPage;

              const sectionMd: string[] = [];
              for (let page = startPage; page <= endPage; page++) {
                const md = pageMarkdown.get(page);
                if (md) sectionMd.push(md);
              }

              if (sectionMd.length > 0) {
                const richContent = sectionMd.join('\n\n');
                await sectionRepository.update(section.id, { richContent });
                mathpixCount++;
              }
            }

            await processingLogRepository.append(jobId, 'mathpix', `Mapped rich content to ${mathpixCount} sections`);
          }
        } catch (err: any) {
          await processingLogRepository.append(
            jobId, 'mathpix',
            `Mathpix failed: ${err.message}`,
            'warn',
          );
        }

        await processingLogRepository.updateJobProgress(jobId, 80, 'mathpix');
      } else {
        await processingLogRepository.append(jobId, 'mathpix', 'Mathpix not configured — skipping rich content extraction');
      }
      } // end mode !== 'toc-only'

      // ── Stage 6: OCR fallback (skip in toc-only mode) ──────────────
      if (mode === 'toc-only') {
        await processingLogRepository.append(jobId, 'ocr', 'TOC-only mode — skipping OCR');
        await processingLogRepository.updateJobProgress(jobId, 90, 'ocr');
      } else {
      await processingLogRepository.updateJobProgress(jobId, 80, 'ocr');
      await processingLogRepository.append(jobId, 'ocr', 'Checking for sections needing OCR...');

      const updatedSections = await sectionRepository.findByBookId(bookId);
      const emptySections = updatedSections.filter(s => !s.extractedText || s.extractedText.trim().length < 20);

      if (emptySections.length > 0) {
        await processingLogRepository.append(
          jobId, 'ocr',
          `Found ${emptySections.length} sections with insufficient text — running OCR...`,
        );

        for (let i = 0; i < emptySections.length; i++) {
          const section = emptySections[i];
          const startPage = section.startPage ?? 1;
          const endPage = section.endPage ?? startPage;

          let ocrText = '';
          for (let page = startPage; page <= endPage; page++) {
            try {
              const imageBuffer = await pdfService.renderPageToImage(pdfBuffer, page, 2.0);
              const base64Image = imageBuffer.toString('base64');

              const { default: Anthropic } = await import('@anthropic-ai/sdk');
              const client = new Anthropic({ timeout: 30_000 });
              const response = await client.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 4096,
                messages: [{
                  role: 'user',
                  content: [
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: base64Image,
                      },
                    },
                    {
                      type: 'text',
                      text: 'Extract all readable text from this page image. Return only the text content, preserving paragraph structure. Do not add any commentary.',
                    },
                  ],
                }],
              });

              const textBlock = response.content.find(b => b.type === 'text');
              if (textBlock && textBlock.type === 'text') {
                ocrText += (ocrText ? '\n\n' : '') + textBlock.text;
              }
            } catch (err: any) {
              await processingLogRepository.append(
                jobId, 'ocr',
                `Warning: OCR failed for page ${page}: ${err.message}`,
                'warn',
              );
            }
          }

          if (ocrText.trim()) {
            await sectionRepository.update(section.id, { extractedText: ocrText.trim() });
          }

          const progress = Math.round(80 + ((i + 1) / emptySections.length) * 10);
          await processingLogRepository.updateJobProgress(jobId, progress, 'ocr');
        }

        await processingLogRepository.append(jobId, 'ocr', `OCR completed for ${emptySections.length} sections`);
      } else {
        await processingLogRepository.append(jobId, 'ocr', 'No sections need OCR — all have text');
      }

      await processingLogRepository.updateJobProgress(jobId, 90, 'ocr');
      } // end mode !== 'toc-only' for OCR

      // ── Stage 7: Generate cover (90-95%) ──────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 90, 'cover');
      await processingLogRepository.append(jobId, 'cover', 'Checking cover image...');

      const catalog = await bookRepository.findCatalogByHash(fileHash);
      if (catalog && !catalog.coverUrl) {
        try {
          const coverBuffer = await pdfService.renderPageToImage(pdfBuffer, 1, 2.0);
          const coverBase64 = `data:image/png;base64,${coverBuffer.toString('base64')}`;

          await bookRepository.updateCatalog(catalog.id, { coverUrl: coverBase64 });
          await processingLogRepository.append(jobId, 'cover', 'Cover generated from page 1');
        } catch (err: any) {
          await processingLogRepository.append(
            jobId, 'cover',
            `Warning: cover generation failed: ${err.message}`,
            'warn',
          );
        }
      } else {
        await processingLogRepository.append(jobId, 'cover', 'Cover already exists — skipping');
      }

      await processingLogRepository.updateJobProgress(jobId, 95, 'cover');

      // ── Stage 8: Finalize (95-100%) ───────────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 95, 'finalize');
      await processingLogRepository.append(jobId, 'finalize', 'Finalizing processing...');

      await bookRepository.update(bookId, { processingStatus: 'complete', structureSource: 'ai' });
      await processingLogRepository.completeJob(jobId);
      await processingLogRepository.append(jobId, 'finalize', 'Processing complete!');

      await doc.destroy().catch(() => {});
    } catch (error: any) {
      const errorMessage = error.message ?? 'Unknown error';
      await processingLogRepository.append(jobId, 'error', `Pipeline failed: ${errorMessage}`, 'error');
      await processingLogRepository.failJob(jobId, errorMessage);
      await markBookErrored(bookId, jobId);
    }
}

// ─── EPUB pipeline ─────────────────────────────────────────────────────────
/**
 * EPUB processing pipeline — much simpler than PDF. No Mathpix, no OCR, no
 * pdfjs. Stages: download, parse (unzip + OPF + chapters), structure (one
 * chapter per EPUB chapter, one section per chapter), cover, finalize.
 */
async function orchestrateEpubPipeline(jobId: string, fileHash: string, bookId: string): Promise<void> {
  try {
    // ── Stage 1: Download (0-10%) ────────────────────────────────
    await processingLogRepository.updateJobProgress(jobId, 0, 'download');
    await processingLogRepository.append(jobId, 'download', 'Downloading EPUB from storage...');

    const [file] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, fileHash)).limit(1);
    if (!file) throw new Error('EPUB file not found in storage');

    const epubBuffer = await storageService.downloadPdf(file.r2Key);
    await processingLogRepository.updateJobProgress(jobId, 10, 'download');
    await processingLogRepository.append(jobId, 'download', `EPUB downloaded (${(epubBuffer.length / 1024).toFixed(0)} KB)`);

    // ── Stage 2: Parse (10-40%) ──────────────────────────────────
    await processingLogRepository.updateJobProgress(jobId, 10, 'parse');
    await processingLogRepository.append(jobId, 'parse', 'Parsing EPUB structure...');

    const book = parseEpub(epubBuffer);
    if (book.chapters.length === 0) {
      throw new Error('EPUB contains no readable chapters');
    }
    await processingLogRepository.append(jobId, 'parse', `Parsed ${book.chapters.length} chapter(s), title="${book.title}", author="${book.author ?? 'unknown'}"`);
    await processingLogRepository.updateJobProgress(jobId, 40, 'parse');

    // ── Stage 3: Structure + text (40-85%) ───────────────────────
    await processingLogRepository.updateJobProgress(jobId, 40, 'structure');
    await processingLogRepository.append(jobId, 'structure', 'Writing chapters and sections to the database...');

    // EPUBs don't have real pages. Use chapterIndex as the page number so the
    // existing page-based progress + navigation logic still works.
    let sectionOrder = 0;
    for (const ch of book.chapters) {
      const chapter = await chapterRepository.create({
        bookId,
        title: ch.title,
        startPage: ch.chapterIndex,
        endPage: ch.chapterIndex,
        sortOrder: ch.chapterIndex - 1,
      });
      await sectionRepository.create({
        bookId,
        chapterId: chapter.id,
        title: ch.title,
        startPage: ch.chapterIndex,
        endPage: ch.chapterIndex,
        sectionType: 'content',
        sortOrder: ++sectionOrder,
        extractedText: ch.plainText,
      });
      const pct = 40 + Math.round((sectionOrder / book.chapters.length) * 45);
      await processingLogRepository.updateJobProgress(jobId, pct, 'structure');
    }
    await processingLogRepository.append(jobId, 'structure', `Wrote ${book.chapters.length} section(s) with extracted text`);

    // ── Stage 4: Cover (85-95%) ──────────────────────────────────
    await processingLogRepository.updateJobProgress(jobId, 85, 'cover');
    const catalog = await bookRepository.findCatalogByHash(fileHash);
    if (catalog && !catalog.coverUrl && book.coverImage) {
      const mime = book.coverMimeType || 'image/jpeg';
      const coverBase64 = `data:${mime};base64,${book.coverImage.toString('base64')}`;
      await bookRepository.updateCatalog(catalog.id, {
        coverUrl: coverBase64,
        // Backfill title/author from EPUB metadata if the user accepted the default
        title: catalog.title && catalog.title !== 'Untitled' ? catalog.title : book.title,
        author: catalog.author ?? book.author ?? undefined,
        totalPages: book.chapters.length,
      });
      await processingLogRepository.append(jobId, 'cover', 'Cover extracted from EPUB metadata');
    } else if (catalog && !catalog.coverUrl) {
      await processingLogRepository.append(jobId, 'cover', 'EPUB has no cover image — skipping', 'warn');
    } else {
      await processingLogRepository.append(jobId, 'cover', 'Cover already exists — skipping');
    }
    await processingLogRepository.updateJobProgress(jobId, 95, 'cover');

    // ── Stage 5: Finalize (95-100%) ──────────────────────────────
    await processingLogRepository.updateJobProgress(jobId, 95, 'finalize');
    await bookRepository.update(bookId, { processingStatus: 'complete', structureSource: 'epub' });
    await processingLogRepository.completeJob(jobId);
    await processingLogRepository.append(jobId, 'finalize', 'EPUB processing complete');
  } catch (error: any) {
    const errorMessage = error.message ?? 'Unknown error';
    await processingLogRepository.append(jobId, 'error', `EPUB pipeline failed: ${errorMessage}`, 'error');
    await processingLogRepository.failJob(jobId, errorMessage);
    await markBookErrored(bookId, jobId);
  }
}

// ─── Helper: Build structure from PDF outline/TOC ───────────────────────────
// Ported from frontend's buildStructureFromOutline + walkOutlineTree + flattenOutline
// This is the battle-tested logic that handles:
// - Chapter vs section detection based on nesting
// - Introduction injection when parent starts before first child
// - Prefix notation for deep nesting ("Part 1 > Chapter 1")
// - Mixed leaf/nested children
// - Page range computation using flattened leaf list

interface ChapterSections {
  chapterTitle: string;
  sections: { title: string; pageNumber: number | null }[];
}

function walkOutlineTree(
  items: OutlineItem[],
  parentPrefix: string,
  result: ChapterSections[],
): void {
  for (const item of items) {
    const children = item.children || [];
    if (children.length === 0) {
      // Leaf node → standalone chapter with one section
      result.push({
        chapterTitle: item.title,
        sections: [{ title: item.title, pageNumber: item.pageNumber }],
      });
    } else if (children.every(c => !c.children || c.children.length === 0)) {
      // All children are leaves → this is a chapter, children are sections
      const title = parentPrefix ? `${parentPrefix} > ${item.title}` : item.title;
      const sections: { title: string; pageNumber: number | null }[] = [];

      // Inject "Introduction" section if parent starts before first child
      const firstChildPage = children[0]?.pageNumber ?? null;
      if (
        item.pageNumber != null &&
        firstChildPage != null &&
        item.pageNumber < firstChildPage
      ) {
        sections.push({
          title: `${item.title} — Introduction`,
          pageNumber: item.pageNumber,
        });
      }

      for (const c of children) {
        sections.push({ title: c.title, pageNumber: c.pageNumber });
      }

      result.push({ chapterTitle: title, sections });
    } else {
      // Has nested children → grouping level, recurse
      const prefix = parentPrefix ? `${parentPrefix} > ${item.title}` : item.title;
      const directLeaves = children.filter(c => !c.children || c.children.length === 0);
      const nestedChildren = children.filter(c => c.children && c.children.length > 0);

      // Inject "Introduction" if parent starts before first child
      const allChildren = [...directLeaves, ...nestedChildren];
      const firstPage = allChildren.reduce((min: number | null, c) => {
        if (c.pageNumber == null) return min;
        if (min == null) return c.pageNumber;
        return c.pageNumber < min ? c.pageNumber : min;
      }, null as number | null);

      const introSections: { title: string; pageNumber: number | null }[] = [];
      if (
        item.pageNumber != null &&
        firstPage != null &&
        item.pageNumber < firstPage
      ) {
        introSections.push({
          title: `${item.title} — Introduction`,
          pageNumber: item.pageNumber,
        });
      }

      if (directLeaves.length > 0 || introSections.length > 0) {
        result.push({
          chapterTitle: prefix,
          sections: [
            ...introSections,
            ...directLeaves.map(c => ({ title: c.title, pageNumber: c.pageNumber })),
          ],
        });
      }
      walkOutlineTree(nestedChildren, prefix, result);
    }
  }
}

async function buildStructureFromOutline(
  jobId: string,
  bookId: string,
  pdfBuffer: Buffer,
  outline: OutlineItem[],
  totalPages: number,
): Promise<void> {
  // Walk tree to get chapter/section pairs (mirrors frontend exactly)
  const result: ChapterSections[] = [];
  walkOutlineTree(outline, '', result);

  // Build flat ordered list of ALL leaf sections for page range computation
  const allLeaves: { title: string; pageNumber: number | null; chapterIdx: number; sectionIdx: number }[] = [];
  result.forEach((ch, ci) => {
    ch.sections.forEach((s, si) => {
      allLeaves.push({ title: s.title, pageNumber: s.pageNumber, chapterIdx: ci, sectionIdx: si });
    });
  });

  let chapterOrder = 0;
  let sectionOrder = 0;

  for (let ci = 0; ci < result.length; ci++) {
    const ch = result[ci];

    // Compute chapter page range from its sections
    const chapterSections = allLeaves.filter(l => l.chapterIdx === ci);
    const firstPage = chapterSections[0]?.pageNumber ?? 1;

    // Find next section AFTER this chapter to determine endPage
    const lastSectionGlobalIdx = allLeaves.findIndex(
      l => l.chapterIdx === ci && l.sectionIdx === ch.sections.length - 1
    );
    const nextLeaf = allLeaves[lastSectionGlobalIdx + 1];
    const endPage = nextLeaf?.pageNumber != null
      ? nextLeaf.pageNumber - 1
      : totalPages;

    const chapter = await chapterRepository.create({
      bookId,
      title: ch.chapterTitle,
      startPage: firstPage,
      endPage: Math.max(firstPage, endPage),
      sortOrder: ++chapterOrder,
    });

    await processingLogRepository.append(
      jobId, 'structure',
      `Chapter: "${ch.chapterTitle}" (pages ${firstPage}-${Math.max(firstPage, endPage)}, ${ch.sections.length} sections)`,
    );

    // Create sections with computed page ranges
    for (let si = 0; si < ch.sections.length; si++) {
      const sec = ch.sections[si];
      const startPage = sec.pageNumber ?? firstPage;

      // Next section's page determines this section's end
      const nextSec = ch.sections[si + 1];
      let secEndPage: number;
      if (nextSec?.pageNumber != null) {
        secEndPage = nextSec.pageNumber - 1;
      } else if (si === ch.sections.length - 1) {
        // Last section in chapter — find next chapter's start
        const nextChSections = result[ci + 1]?.sections;
        if (nextChSections?.[0]?.pageNumber != null) {
          secEndPage = nextChSections[0].pageNumber - 1;
        } else {
          secEndPage = Math.max(firstPage, endPage);
        }
      } else {
        secEndPage = Math.max(firstPage, endPage);
      }
      secEndPage = Math.max(startPage, secEndPage);

      await sectionRepository.create({
        bookId,
        chapterId: chapter.id,
        title: sec.title,
        startPage,
        endPage: secEndPage,
        sectionType: 'content',
        sortOrder: ++sectionOrder,
      });
    }
  }

  await processingLogRepository.append(
    jobId, 'structure',
    `Created ${result.length} chapters with ${allLeaves.length} sections from TOC`,
  );
}

// ─── Helper: Build batch structure when no TOC is available ─────────────────

// Smart batch sizing based on total page count
function getBatchSize(totalPages: number): number {
  if (totalPages <= 20) return totalPages; // 1 chapter total
  if (totalPages <= 100) return 10;
  if (totalPages <= 500) return 20;
  return 30;
}

async function buildBatchStructure(
  jobId: string,
  bookId: string,
  totalPages: number,
): Promise<void> {
  const batchSize = getBatchSize(totalPages);
  const numBatches = Math.ceil(totalPages / batchSize);
  let sectionOrder = 0;

  for (let i = 0; i < numBatches; i++) {
    const batchStart = i * batchSize + 1;
    const batchEnd = Math.min((i + 1) * batchSize, totalPages);

    const chapter = await chapterRepository.create({
      bookId,
      title: `Pages ${batchStart}-${batchEnd}`,
      startPage: batchStart,
      endPage: batchEnd,
      sortOrder: i,
    });

    // One section per page (matches frontend's buildNibChapters)
    for (let page = batchStart; page <= batchEnd; page++) {
      await sectionRepository.create({
        bookId,
        chapterId: chapter.id,
        title: `Page ${page}`,
        startPage: page,
        endPage: page,
        sectionType: 'content',
        sortOrder: ++sectionOrder,
      });
    }
  }

  await processingLogRepository.append(
    jobId, 'structure',
    `Created ${numBatches} batch chapters with ${totalPages} per-page sections`,
  );
}
