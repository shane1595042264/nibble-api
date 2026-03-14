/**
 * Backend PDF service — mirrors the frontend's PDFService but for Node.js.
 * Uses pdfjs-dist legacy build (no DOM required for text extraction).
 * Canvas (node-canvas) only used for renderPageToImage (OCR/cover).
 */
import { createCanvas } from 'canvas';
import type { RawTextItem, RawPageData } from '../lib/nib/parser.js';

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

export interface PdfMetadata {
  title: string;
  author: string;
  totalPages: number;
}

export interface OutlineItem {
  title: string;
  pageNumber: number | null;
  children: OutlineItem[];
}

// ─── Document loading ──────────────────────────────────────────────

/** Load a PDF document. Caller must call doc.destroy() when done. */
async function loadDocument(buffer: Buffer) {
  const data = new Uint8Array(buffer);
  return (pdfjsLib as any).getDocument({ data, useSystemFonts: true }).promise;
}

// ─── Destination resolution (mirrors frontend's resolveDestPage) ───

async function resolveDestPage(dest: any, doc: any): Promise<number | null> {
  try {
    let resolved = dest;
    if (typeof dest === 'string') {
      resolved = await doc.getDestination(dest);
    }
    if (!resolved || !Array.isArray(resolved)) return null;
    const pageRef = resolved[0];
    const pageIndex = await doc.getPageIndex(pageRef);
    return pageIndex + 1; // 1-indexed
  } catch {
    return null;
  }
}

// ─── Outline mapping (mirrors frontend's mapOutlineItems) ──────────

async function mapOutlineItems(items: any[], doc: any): Promise<OutlineItem[]> {
  const result: OutlineItem[] = [];
  for (const item of items) {
    const pageNumber = await resolveDestPage(item.dest, doc);
    const children = item.items?.length
      ? await mapOutlineItems(item.items, doc)
      : [];
    result.push({ title: item.title, pageNumber, children });
  }
  return result;
}

// ─── Exported service ──────────────────────────────────────────────

export const pdfService = {
  loadDocument,

  async extractMetadata(buffer: Buffer): Promise<PdfMetadata> {
    const doc = await loadDocument(buffer);
    try {
      const metadata = await doc.getMetadata();
      const info = metadata.info as Record<string, any>;
      return {
        title: info?.Title || 'Untitled',
        author: info?.Author || 'Unknown',
        totalPages: doc.numPages,
      };
    } finally {
      doc.destroy();
    }
  },

  /**
   * Extract outline — mirrors frontend's extractOutline + mapOutlineItems.
   * Recursively resolves all destinations to page numbers.
   */
  async extractOutline(buffer: Buffer): Promise<OutlineItem[] | null> {
    const doc = await loadDocument(buffer);
    try {
      const outline = await doc.getOutline();
      if (!outline || outline.length === 0) return null;
      return await mapOutlineItems(outline, doc);
    } finally {
      doc.destroy();
    }
  },

  /** Same as extractOutline but reuses an already-loaded doc */
  async extractOutlineFromDoc(doc: any): Promise<OutlineItem[] | null> {
    const outline = await doc.getOutline();
    if (!outline || outline.length === 0) return null;
    return await mapOutlineItems(outline, doc);
  },

  /**
   * Extract rich text data for a range of pages — mirrors frontend's extractRichPageRange.
   * Returns RawPageData[] compatible with NibParser.parseDocument().
   *
   * Differences from frontend:
   * - No canvas rendering (no image extraction from pages)
   * - Font name resolution via page.commonObjs.get(fontId) — same as frontend
   */
  async extractRichPageRangeFromDoc(doc: any, startPage: number, endPage: number): Promise<RawPageData[]> {
    const results: RawPageData[] = [];

    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();

      // Build font name map — resolve opaque font IDs to real font names
      // (e.g. "g_d0_f1" → "TimesNewRomanPS-BoldMT")
      // This is critical for NibParser's header/footer detection which uses font size
      const fontNameMap = new Map<string, string>();
      const seenFontIds = new Set<string>();
      for (const item of textContent.items as any[]) {
        if (item.fontName) seenFontIds.add(item.fontName);
      }
      for (const fontId of seenFontIds) {
        try {
          const fontObj = page.commonObjs.get(fontId);
          if (fontObj?.name) {
            fontNameMap.set(fontId, fontObj.name);
          }
        } catch {
          // Font not resolved — fall back to opaque ID
        }
      }

      const items: RawTextItem[] = textContent.items
        .filter((item: any) => item.str && item.str.trim().length > 0)
        .map((item: any) => ({
          str: item.str,
          transform: item.transform,
          width: item.width,
          height: item.height,
          fontName: fontNameMap.get(item.fontName) ?? item.fontName ?? '',
          hasEOL: item.hasEOL ?? false,
        }));

      results.push({
        pageNumber: pageNum,
        items,
        pageHeight: viewport.height,
        pageWidth: viewport.width,
      });
    }

    return results;
  },

  /** Convenience: load doc, extract range, destroy doc */
  async extractRichPageRange(buffer: Buffer, startPage: number, endPage: number): Promise<RawPageData[]> {
    const doc = await loadDocument(buffer);
    try {
      return await this.extractRichPageRangeFromDoc(doc, startPage, endPage);
    } finally {
      doc.destroy();
    }
  },

  /** Extract raw text from a single page (fallback when NibParser fails) */
  async extractPageTextFromDoc(doc: any, pageNumber: number): Promise<string> {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    return textContent.items.map((item: any) => item.str).join(' ');
  },

  async extractPageText(buffer: Buffer, pageNumber: number): Promise<string> {
    const doc = await loadDocument(buffer);
    try {
      return await this.extractPageTextFromDoc(doc, pageNumber);
    } finally {
      doc.destroy();
    }
  },

  /** Render a page to PNG image buffer (for OCR + cover generation) */
  async renderPageToImageFromDoc(doc: any, pageNumber: number, scale: number = 2.0): Promise<Buffer> {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    await page.render({
      canvasContext: context as any,
      viewport,
    }).promise;

    return canvas.toBuffer('image/png');
  },

  async renderPageToImage(buffer: Buffer, pageNumber: number, scale: number = 2.0): Promise<Buffer> {
    const doc = await loadDocument(buffer);
    try {
      return await this.renderPageToImageFromDoc(doc, pageNumber, scale);
    } finally {
      doc.destroy();
    }
  },

  resolveDestPage,
};
