import pdf from 'pdf-parse';

class PdfService {
  /**
   * Extracts raw text content from a PDF buffer.
   * @param pdfBuffer The PDF file content as a Buffer.
   * @returns A Promise that resolves with the extracted text.
   */
  async extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
    try {
      const data = await pdf(pdfBuffer);
      return data.text;
    } catch (error) {
      console.error('Error extracting text from PDF:', error);
      throw new Error('Failed to extract text from PDF.');
    }
  }
}

export const pdfService = new PdfService();