import { storageService } from './storage.service.js';
import { pdfService, type OutlineItem } from './pdf.service.js';
import { bookRepository } from '../repositories/book.repository.js';
import { processingLogRepository } from '../repositories/processing-log.repository.js';
import { chapterRepository } from '../repositories/chapter.repository.js';
import { sectionRepository } from '../repositories/section.repository.js';
import { NibParser } from '../lib/nib/parser.js';
import { db } from '../db/index.js';
import { pdfFiles, sections, chapters, bookCatalog, books } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const parser = new NibParser();

export const processingService = {
  /**
   * 8-stage processing pipeline for a PDF book.
   */
  async orchestratePipeline(jobId: string, fileHash: string, bookId: string): Promise<void> {
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
      } catch { /* ignore metadata errors */ }

      await processingLogRepository.append(
        jobId, 'metadata',
        `Metadata extracted: ${totalPages} pages, title="${metadataTitle}", author="${metadataAuthor}"`,
      );
      await processingLogRepository.updateJobProgress(jobId, 10, 'metadata');

      // ── Stage 3: Parse TOC (10-15%) ───────────────────────────────
      await processingLogRepository.updateJobProgress(jobId, 10, 'toc');
      await processingLogRepository.append(jobId, 'toc', 'Extracting table of contents...');

      const outline = await pdfService.extractOutlineFromDoc(doc);
      const hasToc = outline.length > 0;

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

      if (hasToc) {
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

        let sectionText = '';
        for (let page = startPage; page <= endPage; page++) {
          try {
            const rawPageData = await pdfService.extractRichPageDataFromDoc(doc, page);
            // Convert to NibParser's expected format
            const parserInput = {
              pageNumber: rawPageData.pageNumber,
              items: rawPageData.items.map(item => ({
                str: item.text,
                transform: item.transform,
                width: item.width,
                height: item.height,
                fontName: item.fontName,
                hasEOL: item.hasEOL,
              })),
              pageHeight: rawPageData.height,
              pageWidth: rawPageData.width,
            };
            const nibPage = parser.parsePage(parserInput);
            const pageText = nibPage.paragraphs
              .map(p => p.sentences.map(s => s.words.map(w => w.text).join(' ')).join(' '))
              .join('\n\n');
            sectionText += (sectionText ? '\n\n' : '') + pageText;
          } catch (err: any) {
            await processingLogRepository.append(
              jobId, 'text_extraction',
              `Warning: failed to extract page ${page}: ${err.message}`,
              'warn',
            );
          }
        }

        // Write extracted text to section
        if (sectionText.trim()) {
          await sectionRepository.update(section.id, { extractedText: sectionText.trim() });
        }

        // Update progress (20% to 80% range)
        const progress = Math.round(20 + ((i + 1) / totalSections) * 60);
        await processingLogRepository.updateJobProgress(jobId, progress, 'text_extraction');

        if ((i + 1) % 5 === 0 || i === totalSections - 1) {
          await processingLogRepository.append(
            jobId, 'text_extraction',
            `Extracted text for ${i + 1}/${totalSections} sections`,
          );
        }
      }

      // ── Stage 6: OCR fallback (80-90%) ────────────────────────────
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
              const client = new Anthropic();
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
      await bookRepository.update(bookId, { processingStatus: 'error' }).catch(() => {});
    }
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

// ─── Helper: Build structure from PDF outline/TOC ───────────────────────────

async function buildStructureFromOutline(
  jobId: string,
  bookId: string,
  pdfBuffer: Buffer,
  outline: OutlineItem[],
  totalPages: number,
): Promise<void> {
  let globalSortOrder = 0;

  async function processOutlineItems(
    items: OutlineItem[],
    parentChapterId: string | null,
    depth: number,
  ): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const startPage = item.pageNumber ?? 1;

      // Determine endPage: next sibling's startPage - 1, or totalPages
      let endPage: number;
      if (i + 1 < items.length && items[i + 1].pageNumber) {
        endPage = items[i + 1].pageNumber! - 1;
      } else {
        endPage = totalPages;
      }
      // Ensure endPage >= startPage
      endPage = Math.max(endPage, startPage);

      if (depth === 0) {
        // Top-level items become chapters
        const chapter = await chapterRepository.create({
          bookId,
          title: item.title,
          startPage,
          endPage,
          sortOrder: globalSortOrder++,
        });

        await processingLogRepository.append(
          jobId, 'structure',
          `Chapter: "${item.title}" (pages ${startPage}-${endPage})`,
        );

        if (item.children.length > 0) {
          // Children become sections within this chapter
          await processOutlineItems(item.children, chapter.id, depth + 1);
        } else {
          // No children: create a single section for the whole chapter
          await sectionRepository.create({
            bookId,
            chapterId: chapter.id,
            title: item.title,
            startPage,
            endPage,
            sectionType: 'content',
            sortOrder: 0,
          });
        }
      } else if (parentChapterId) {
        // Nested items become sections
        await sectionRepository.create({
          bookId,
          chapterId: parentChapterId,
          title: item.title,
          startPage,
          endPage,
          sectionType: 'content',
          sortOrder: globalSortOrder++,
        });

        // If there are deeper children, we still create sections (flatten)
        if (item.children.length > 0) {
          await processOutlineItems(item.children, parentChapterId, depth + 1);
        }
      }
    }
  }

  await processOutlineItems(outline, null, 0);
}

// ─── Helper: Build batch structure when no TOC is available ─────────────────

async function buildBatchStructure(
  jobId: string,
  bookId: string,
  totalPages: number,
): Promise<void> {
  const batchSize = 10;
  const numBatches = Math.ceil(totalPages / batchSize);

  for (let i = 0; i < numBatches; i++) {
    const startPage = i * batchSize + 1;
    const endPage = Math.min((i + 1) * batchSize, totalPages);

    const chapter = await chapterRepository.create({
      bookId,
      title: `Pages ${startPage}–${endPage}`,
      startPage,
      endPage,
      sortOrder: i,
    });

    await sectionRepository.create({
      bookId,
      chapterId: chapter.id,
      title: `Pages ${startPage}–${endPage}`,
      startPage,
      endPage,
      sectionType: 'content',
      sortOrder: 0,
    });
  }

  await processingLogRepository.append(
    jobId, 'structure',
    `Created ${numBatches} batch chapters (${batchSize} pages each)`,
  );
}
