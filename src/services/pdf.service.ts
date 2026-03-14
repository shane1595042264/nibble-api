import { createCanvas } from 'canvas';

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

export interface RichTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
  transform: number[];
}

export interface RawPageData {
  pageNumber: number;
  width: number;
  height: number;
  items: RichTextItem[];
}

export interface PdfMetadata {
  title: string | null;
  author: string | null;
  totalPages: number;
}

export interface OutlineItem {
  title: string;
  pageNumber: number | null;
  children: OutlineItem[];
}

/** Load a PDF document once — caller is responsible for calling doc.destroy() */
async function loadDocument(buffer: Buffer) {
  const data = new Uint8Array(buffer);
  const doc = await (pdfjsLib as any).getDocument({ data, useSystemFonts: true }).promise;
  return doc;
}

/** Resolve a PDF destination to a 1-based page number.
 *  Uses a timeout to prevent hanging on malformed destinations. */
async function resolveDestToPage(doc: any, dest: any): Promise<number | null> {
  try {
    if (typeof dest === 'string') {
      const resolved = await Promise.race([
        doc.getDestination(dest),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      dest = resolved;
    }
    if (!dest || !Array.isArray(dest)) return null;
    const ref = dest[0];
    const pageIndex = await Promise.race([
      doc.getPageIndex(ref),
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return pageIndex + 1; // 1-based
  } catch {
    return null;
  }
}

export const pdfService = {
  loadDocument,

  async extractMetadata(buffer: Buffer): Promise<PdfMetadata> {
    const doc = await loadDocument(buffer);
    try {
      const metadata = await doc.getMetadata();
      const info = metadata?.info as any;
      return {
        title: info?.Title || null,
        author: info?.Author || null,
        totalPages: doc.numPages,
      };
    } finally {
      await doc.destroy();
    }
  },

  /** Extract outline using a pre-loaded document (avoids re-parsing the PDF) */
  async extractOutlineFromDoc(doc: any): Promise<OutlineItem[]> {
    const outline = await doc.getOutline();
    if (!outline) return [];

    async function processItems(items: any[], depth = 0): Promise<OutlineItem[]> {
      if (depth > 5) return [];
      const result: OutlineItem[] = [];
      for (const item of items) {
        const pageNumber = await resolveDestToPage(doc, item.dest);
        const children = item.items?.length
          ? await processItems(item.items, depth + 1)
          : [];
        result.push({
          title: item.title,
          pageNumber,
          children,
        });
      }
      return result;
    }

    return processItems(outline);
  },

  /** Extract outline — loads document internally (convenience method) */
  async extractOutline(buffer: Buffer): Promise<OutlineItem[]> {
    const doc = await loadDocument(buffer);
    try {
      return await this.extractOutlineFromDoc(doc);
    } finally {
      await doc.destroy();
    }
  },

  /** Extract rich text data from a page using a pre-loaded document */
  async extractRichPageDataFromDoc(doc: any, pageNumber: number): Promise<RawPageData> {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();

    const items: RichTextItem[] = textContent.items
      .filter((item: any) => item.str !== undefined)
      .map((item: any) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
        fontName: item.fontName || '',
        hasEOL: item.hasEOL || false,
        transform: item.transform,
      }));

    return {
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      items,
    };
  },

  async extractRichPageData(buffer: Buffer, pageNumber: number): Promise<RawPageData> {
    const doc = await loadDocument(buffer);
    try {
      return await this.extractRichPageDataFromDoc(doc, pageNumber);
    } finally {
      await doc.destroy();
    }
  },

  /** Extract raw text from a page using a pre-loaded document */
  async extractPageTextFromDoc(doc: any, pageNumber: number): Promise<string> {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    return textContent.items
      .filter((item: any) => item.str !== undefined)
      .map((item: any) => item.str)
      .join('');
  },

  async extractPageText(buffer: Buffer, pageNumber: number): Promise<string> {
    const doc = await loadDocument(buffer);
    try {
      return await this.extractPageTextFromDoc(doc, pageNumber);
    } finally {
      await doc.destroy();
    }
  },

  async renderPageToImage(
    buffer: Buffer,
    pageNumber: number,
    scale: number = 2.0
  ): Promise<Buffer> {
    const doc = await loadDocument(buffer);
    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      const renderContext = {
        canvasContext: context as any,
        viewport,
      };

      await page.render(renderContext).promise;

      return canvas.toBuffer('image/png');
    } finally {
      await doc.destroy();
    }
  },

  resolveDestToPage,
};
