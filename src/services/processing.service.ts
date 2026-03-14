import { storageService } from './storage.service.js';
import { aiService, type PageAnalysis } from './ai.service.js';
import { mathpixService, type MathRegion } from './mathpix.service.js';
import { bookRepository } from '../repositories/book.repository.js';
import { exerciseRepository } from '../repositories/exercise.repository.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { db } from '../db/index.js';
import { nibCache, pdfFiles, chapters, sections } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const processingService = {
  async orchestratePipeline(jobId: string, fileHash: string, userId: string): Promise<void> {
    console.log(`[Job ${jobId}] Starting PDF processing pipeline for file: ${fileHash}`);
    const job = await billingRepository.findJobById(jobId);
    if (!job) throw new Error('Job not found');

    try {
      // Update progress
      const updateProgress = async (progress: number) => {
        await billingRepository.updateJobStatus(jobId, { progress, status: 'processing' });
      };

      // Step 1: Download PDF from R2
      await updateProgress(5);
      const [pdfFile] = await db.select().from(pdfFiles).where(eq(pdfFiles.fileHash, fileHash)).limit(1);
      if (!pdfFile) throw new Error('PDF not found in storage');
      const pdfBuffer = await storageService.downloadPdf(pdfFile.r2Key);
      console.log(`[Job ${jobId}] Step 1: PDF downloaded. Size: ${pdfBuffer.length} bytes.`);

      // Step 2: Extract text (using pdfjs-dist would go here in production)
      // For now, we'll work with a placeholder text extraction
      await updateProgress(15);
      const extractedText = await extractTextFromPdf(pdfBuffer);
      console.log(`[Job ${jobId}] Step 2: Text extraction complete. Pages: ${extractedText.length}.`);

      // Step 3: Claude TEXT - structure classification (cheap, all pages)
      await updateProgress(25);
      const pageAnalyses = await aiService.classifyPages(extractedText);
      console.log(`[Job ${jobId}] Step 3: AI classified ${pageAnalyses.length} pages for structure.`);

      // Step 4: Update chapters/sections in DB from analysis
      await updateProgress(40);
      await updateStructureFromAnalysis(jobId, userId, fileHash, pageAnalyses);
      console.log(`[Job ${jobId}] Step 4: Chapters and sections updated in DB.`);

      // Step 5: Detect math pages (free, local)
      const mathPages = aiService.detectMathPages(extractedText, pageAnalyses);
      await updateProgress(50);
      console.log(`[Job ${jobId}] Step 5: Detected ${mathPages.length} math-heavy pages.`);

      // Step 6: Extract exercises
      const exercises = aiService.identifyExercises(pageAnalyses);
      await updateProgress(60);
      console.log(`[Job ${jobId}] Step 6: Identified ${exercises.length} exercises.`);

      // Step 7: Store exercises in DB
      const catalogEntry = await bookRepository.findCatalogByHash(fileHash);
      if (catalogEntry && exercises.length > 0) {
        await exerciseRepository.bulkCreate(
          exercises.map((ex, idx) => ({
            catalogId: catalogEntry.id,
            chapterTitle: ex.chapterTitle,
            exerciseNumber: ex.exerciseNumber,
            content: ex.content,
            page: ex.page,
            exerciseType: ex.exerciseType,
            sortOrder: idx,
          }))
        );
        console.log(`[Job ${jobId}] Step 7: Stored ${exercises.length} exercises in DB.`);
      } else {
        console.log(`[Job ${jobId}] Step 7: No exercises to store or catalog entry not found.`);
      }
      await updateProgress(70);

      // Step 8: Vision + Mathpix for math pages (skipped if no math pages or services not configured)
      // This is where Claude Vision + Mathpix would run for math-heavy pages
      // For now, we build the .nib without math LaTeX
      await updateProgress(85);
      console.log(`[Job ${jobId}] Step 8: Mathpix processing (placeholder, currently skipped).`);

      // Step 9: Assemble .nib JSON
      const nibDocument = assembleNib(extractedText, pageAnalyses);
      const nibJson = JSON.stringify(nibDocument);
      console.log(`[Job ${jobId}] Step 9: Assembled .nib document.`);

      // Step 10: Upload .nib to R2
      const r2Key = await storageService.uploadNib(fileHash, nibJson);
      console.log(`[Job ${jobId}] Step 10: Uploaded .nib to R2: ${r2Key}.`);

      // Step 11: Store in nib_cache
      await db.insert(nibCache).values({
        fileHash,
        r2Key,
        pageCount: extractedText.length,
        sizeBytes: Buffer.byteLength(nibJson),
      }).onConflictDoNothing();
      console.log(`[Job ${jobId}] Step 11: Cached .nib metadata.`);

      await updateProgress(100);
      await billingRepository.updateJobStatus(jobId, { status: 'completed', progress: 100 });
      console.log(`[Job ${jobId}] PDF processing pipeline completed successfully.`);

    } catch (error: any) {
      console.error(`[Job ${jobId}] PDF processing pipeline failed: ${error.message}`);
      await billingRepository.updateJobStatus(jobId, {
        status: 'failed',
        error: error.message ?? 'Unknown error',
      });
      throw error;
    }
  },
};

// Helper: Extract text from PDF buffer (simplified — in production use pdfjs-dist)
async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string[]> {
  // Placeholder: in production, use pdfjs-dist to extract text per page
  // For now, return empty array — the actual extraction will be done by the frontend
  // or via pdfjs-dist when it's properly configured for Node.js
  return [];
}

// Helper: Update DB structure from Claude's analysis
async function updateStructureFromAnalysis(
  jobId: string, userId: string, fileHash: string, analyses: PageAnalysis[]
) {
  console.log(`[Job ${jobId}]   Starting structure update from AI analysis.`);
  const catalogEntry = await bookRepository.findCatalogByHash(fileHash);
  if (!catalogEntry) {
    console.log(`[Job ${jobId}]   Catalog entry not found for hash ${fileHash}. Skipping structure update.`);
    return;
  }

  const books = await bookRepository.findByUserId(userId);
  const book = books.find(b => b.catalogId === catalogEntry.id);
  if (!book) {
    console.log(`[Job ${jobId}]   Book not found for user ${userId} and catalog ${catalogEntry.id}. Skipping structure update.`);
    return;
  }

  // Extract unique chapters from analyses
  const chapterMap = new Map<string, { title: string; startPage: number; endPage: number }>();
  for (const page of analyses) {
    if (page.chapterTitle && !chapterMap.has(page.chapterTitle)) {
      chapterMap.set(page.chapterTitle, {
        title: page.chapterTitle,
        startPage: page.page,
        endPage: page.page,
      });
    }
    if (page.chapterTitle && chapterMap.has(page.chapterTitle)) {
      const ch = chapterMap.get(page.chapterTitle)!;
      ch.endPage = Math.max(ch.endPage, page.page);
    }
  }

  // Create chapters
  const chapterEntries = Array.from(chapterMap.values());
  if (chapterEntries.length > 0) {
    const { chapterRepository } = await import('../repositories/chapter.repository.js');
    const createdChapters = await chapterRepository.bulkCreate(
      chapterEntries.map((ch, idx) => ({
        bookId: book.id,
        title: ch.title,
        startPage: ch.startPage,
        endPage: ch.endPage,
        sortOrder: idx,
      }))
    );
    console.log(`[Job ${jobId}]   Created ${createdChapters.length} chapters.`);

    // Create sections from analyses
    const { sectionRepository } = await import('../repositories/section.repository.js');
    const sectionMap = new Map<string, { title: string; chapterId: string; startPage: number; endPage: number; sectionType: string }>();

    for (const page of analyses) {
      if (page.sectionTitle) {
        const chapter = createdChapters.find(c => c.title === page.chapterTitle);
        if (chapter && !sectionMap.has(page.sectionTitle)) {
          sectionMap.set(page.sectionTitle, {
            title: page.sectionTitle,
            chapterId: chapter.id,
            startPage: page.page,
            endPage: page.page,
            sectionType: 'content',
          });
        }
        if (page.sectionTitle && sectionMap.has(page.sectionTitle)) {
          const sec = sectionMap.get(page.sectionTitle)!;
          sec.endPage = Math.max(sec.endPage, page.page);
        }
      }
    }

    if (sectionMap.size > 0) {
      await sectionRepository.bulkCreate(
        Array.from(sectionMap.values()).map((sec, idx) => ({
          bookId: book.id,
          chapterId: sec.chapterId,
          title: sec.title,
          startPage: sec.startPage,
          endPage: sec.endPage,
          sectionType: sec.sectionType,
          sortOrder: idx,
        }))
      );
      console.log(`[Job ${jobId}]   Created ${sectionMap.size} sections.`);
    } else {
      console.log(`[Job ${jobId}]   No sections detected to create.`);
    }
  } else {
    console.log(`[Job ${jobId}]   No chapters detected to create.`);
  }

  // Update book processing status
  await bookRepository.update(book.id, { processingStatus: 'complete', structureSource: 'ai' });
  console.log(`[Job ${jobId}]   Book processing status updated to 'complete' for structure source 'ai'.`);
}