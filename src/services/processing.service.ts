// src/services/processing.service.ts
import { storageService } from './storage.service.js';
import { mathpixService } from './mathpix.service.js'; // Assuming this is the "smart" parser
import { aiService } from './ai.service.js';
import { pdfService } from './pdf.service.js'; // NEW
// Assuming other imports like repositories for saving data

// Define a basic structure for processed content, matching what AI service might return
interface ProcessedSection {
  title: string;
  content: string;
  type: 'text' | 'figure' | 'table' | 'heading';
  page?: number;
}

interface ProcessedDocument {
  type: 'structured_pdf' | 'general_pdf';
  sections: ProcessedSection[];
  // Add other metadata as needed, e.g., rawText for general PDFs
  rawText?: string;
  // Potentially Mathpix specific data for structured PDFs
  mathpixData?: any;
}

class ProcessingService {
  /**
   * Orchestrates the PDF processing pipeline.
   * It attempts smart parsing first, then falls back to general PDF processing
   * for documents without a detected Table of Contents or structured data.
   * @param jobId The ID of the processing job.
   * @param fileHash The hash of the file to process.
   * @param userId The ID of the user who uploaded the file.
   */
  async orchestratePipeline(jobId: string, fileHash: string, userId: string): Promise<void> {
    console.log(`Job ${jobId}: Starting PDF processing for file ${fileHash}`);
    const pdfBuffer = await storageService.getFile(fileHash); // Get PDF content from storage

    let processedDocument: ProcessedDocument | null = null;
    let isGeneralPdf = false;

    try {
      // Attempt smart parsing (e.g., using Mathpix for structured PDFs)
      // Mathpix typically returns a structured JSON output.
      const mathpixResult = await mathpixService.processPdf(pdfBuffer); // Assuming this method exists and returns structured data

      // Heuristic to determine if Mathpix result is "structured enough"
      // This might involve checking for presence of sections, headings, or a TOC-like structure
      if (mathpixResult && mathpixResult.sections && mathpixResult.sections.length > 0) {
        // Assuming mathpixResult.sections is an array of structured sections
        processedDocument = {
          type: 'structured_pdf',
          sections: mathpixResult.sections.map((s: any) => ({ // Map Mathpix sections to our common interface
            title: s.title || 'Untitled Section',
            content: s.text_content || s.content,
            type: s.type || 'text',
            page: s.page_number
          })),
          mathpixData: mathpixResult // Keep original Mathpix data if needed
        };
        console.log(`Job ${jobId}: Successfully processed with smart parser (Mathpix).`);
      } else {
        // Mathpix didn't provide structured content or returned an empty result,
        // treat as a general PDF.
        isGeneralPdf = true;
        console.log(`Job ${jobId}: Smart parser returned unstructured/empty data, falling back to general PDF processing.`);
      }
    } catch (error) {
      // Smart parser failed (e.g., due to PDF format, API error), treat as general PDF
      isGeneralPdf = true;
      console.warn(`Job ${jobId}: Smart parser failed (${(error as Error).message}), falling back to general PDF processing.`);
    }

    if (isGeneralPdf) {
      // General PDF processing path: extract raw text and use cheaper AI for labeling
      console.log(`Job ${jobId}: Initiating general PDF processing.`);
      const rawText = await pdfService.extractTextFromPdf(pdfBuffer);
      const labeledSections = await aiService.labelSectionsFromRawText(rawText);

      processedDocument = {
        type: 'general_pdf',
        sections: labeledSections,
        rawText: rawText // Store raw text for general PDFs
      };
      console.log(`Job ${jobId}: Processed as general PDF with raw text extraction and AI labeling.`);
    }

    if (!processedDocument) {
      throw new Error(`Job ${jobId}: Failed to process PDF, no document data generated.`);
    }

    // Now, store the processedDocument data.
    // This part would typically involve interacting with your database repositories
    // (e.g., bookRepository, chapterRepository, sectionRepository) to persist the extracted information.
    await this.saveProcessedDocument(jobId, userId, fileHash, processedDocument);
    console.log(`Job ${jobId}: PDF processing pipeline completed.`);
  }

  /**
   * Placeholder method to save the processed document data to the database.
   * This would involve mapping the `ProcessedDocument` to your Drizzle schema.
   * @param jobId The ID of the processing job.
   * @param userId The ID of the user.
   * @param fileHash The hash of the file.
   * @param document The processed document data.
   */
  private async saveProcessedDocument(jobId: string, userId: string, fileHash: string, document: ProcessedDocument): Promise<void> {
    console.log(`Job ${jobId}: Saving processed document data for user ${userId} and file ${fileHash}.`);
    // Example:
    // const book = await bookRepository.create({ userId, title: 'Processed Document', fileHash, type: document.type });
    // for (const section of document.sections) {
    //   await sectionRepository.create({ bookId: book.id, title: section.title, content: section.content, type: section.type, page: section.page });
    // }
    // This is a simplified representation. Actual saving logic would be more complex.
    console.log(`Job ${jobId}: Document saved (mock). Sections found: ${document.sections.length}`);
  }
}

export const processingService = new ProcessingService();