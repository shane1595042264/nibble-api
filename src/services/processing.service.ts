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

      // Step 2: Extract text (using pdfjs-dist would go here in production)
      // For now, we'll work with a placeholder text extraction
      await updateProgress(15);
      const extractedText = await extractTextFromPdf(pdfBuffer);

      // Step 3: Claude TEXT - structure classification (cheap, all pages)
      await updateProgress(25);
      const pageAnalyses = await aiService.classifyPages(extractedText);

      // Step 4: Update chapters/sections in DB from analysis
      await updateProgress(40);
      await updateStructureFromAnalysis(jobId, userId, fileHash, pageAnalyses);

      // Step 5: Detect math pages (free, local)
      const mathPages = aiService.detectMathPages(extractedText, pageAnalyses);
      await updateProgress(50);

      // Step 6: Extract exercises
      const exercises = aiService.identifyExercises(pageAnalyses);
      await updateProgress(60);

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
      }
      await updateProgress(70);

      // Step 8: Vision + Mathpix for math pages (skipped if no math pages or services not configured)
      // This is where Claude Vision + Mathpix would run for math-heavy pages
      // For now, we build the .nib without math LaTeX
      await updateProgress(85);

      // Step 9: Assemble .nib JSON
      const nibDocument = assembleNib(extractedText, pageAnalyses);
      const nibJson = JSON.stringify(nibDocument);

      // Step 10: Upload .nib to R2
      const r2Key = await storageService.uploadNib(fileHash, nibJson);

      // Step 11: Store in nib_cache
      await db.insert(nibCache).values({
        fileHash,
        r2Key,
        pageCount: extractedText.length,
        sizeBytes: Buffer.byteLength(nibJson),
      }).onConflictDoNothing();

      await updateProgress(100);
      await billingRepository.updateJobStatus(jobId, { status: 'completed', progress: 100 });

    } catch (error: any) {
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
  const catalogEntry = await bookRepository.findCatalogByHash(fileHash);
  if (!catalogEntry) return;

  const books = await bookRepository.findByUserId(userId);
  const book = books.find(b => b.catalogId === catalogEntry.id);
  if (!book) return;

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
    }
  }

  // Update book processing status
  await bookRepository.update(book.id, { processingStatus: 'complete', structureSource: 'ai' });
}

// Helper: Assemble .nib JSON structure
function assembleNib(extractedText: string[], analyses: PageAnalysis[]) {
  const pages = extractedText.map((text, idx) => {
    const pageNum = idx + 1;
    const analysis = analyses.find(a => a.page === pageNum);

    // Split text into paragraphs
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim()).map((paraText, pIdx) => {
      const sentences = paraText.split(/(?<=[.!?])\s+/).filter(s => s.trim());
      const block = analysis?.blocks.find(b => b.startLine <= pIdx && b.endLine >= pIdx);

      return {
        index: pIdx,
        blockType: block?.type ?? 'body',
        sentences: sentences.map((sentText, sIdx) => ({
          index: sIdx,
          words: sentText.split(/\s+/).filter(w => w).map((wordText, wIdx) => ({
            index: wIdx,
            text: wordText,
          })),
        })),
      };
    });

    return {
      pageNumber: pageNum,
      paragraphs,
      chapterTitle: analysis?.chapterTitle,
      sectionTitle: analysis?.sectionTitle,
    };
  });

  return {
    version: 1,
    pageCount: pages.length,
    pages,
  };
}
