import { config } from '../lib/config.js';

export interface MathRegion {
  id: string;
  imageBuffer: Buffer;
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
}

export const mathpixService = {
  isConfigured(): boolean {
    return !!(config.MATHPIX_APP_ID && config.MATHPIX_APP_KEY);
  },

  /** Convert a single image to LaTeX */
  async convertImageToLatex(imageBuffer: Buffer): Promise<string> {
    if (!this.isConfigured()) throw new Error('Mathpix not configured');

    const base64 = imageBuffer.toString('base64');
    const res = await fetch('https://api.mathpix.com/v3/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'app_id': config.MATHPIX_APP_ID,
        'app_key': config.MATHPIX_APP_KEY,
      },
      body: JSON.stringify({
        src: `data:image/png;base64,${base64}`,
        formats: ['latex_simplified'],
        data_options: { include_latex: true },
      }),
    });

    if (!res.ok) throw new Error(`Mathpix error: ${res.status}`);
    const data = await res.json();
    return data.latex_simplified ?? data.text ?? '';
  },

  /**
   * Convert a PDF to rich Markdown using Mathpix's PDF endpoint.
   * Sends the entire PDF, gets back Markdown for all pages.
   * Returns an array of page Markdown strings.
   */
  async convertPdfToMarkdown(pdfBuffer: Buffer): Promise<string[]> {
    if (!this.isConfigured()) throw new Error('Mathpix not configured');

    // Step 1: Upload PDF
    const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
    const formData = new FormData();
    formData.append('file', blob, 'document.pdf');
    formData.append('options_json', JSON.stringify({
      conversion_formats: { md: true },
      math_inline_delimiters: ['$', '$'],
      math_display_delimiters: ['$$', '$$'],
      enable_tables_fallback: true,
    }));

    const uploadRes = await fetch('https://api.mathpix.com/v3/pdf', {
      method: 'POST',
      headers: {
        'app_id': config.MATHPIX_APP_ID,
        'app_key': config.MATHPIX_APP_KEY,
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '');
      throw new Error(`Mathpix PDF upload error ${uploadRes.status}: ${errText}`);
    }

    const { pdf_id } = await uploadRes.json();

    // Step 2: Poll for completion
    let attempts = 0;
    while (attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusRes = await fetch(`https://api.mathpix.com/v3/pdf/${pdf_id}`, {
        headers: {
          'app_id': config.MATHPIX_APP_ID,
          'app_key': config.MATHPIX_APP_KEY,
        },
      });
      if (!statusRes.ok) throw new Error(`Mathpix status error ${statusRes.status}`);
      const status = await statusRes.json();
      if (status.status === 'completed') break;
      if (status.status === 'error') throw new Error(`Mathpix processing error: ${status.error}`);
      attempts++;
    }

    // Step 3: Download both per-page lines AND full .md
    // .lines.json gives us per-page text (but no images)
    // .md gives us the full document with images in correct positions
    const [linesRes, mdRes] = await Promise.all([
      fetch(`https://api.mathpix.com/v3/pdf/${pdf_id}.lines.json`, {
        headers: { 'app_id': config.MATHPIX_APP_ID, 'app_key': config.MATHPIX_APP_KEY },
      }),
      fetch(`https://api.mathpix.com/v3/pdf/${pdf_id}.md`, {
        headers: { 'app_id': config.MATHPIX_APP_ID, 'app_key': config.MATHPIX_APP_KEY },
      }),
    ]);

    if (!linesRes.ok) throw new Error(`Mathpix lines download error ${linesRes.status}`);
    const data = await linesRes.json() as { pages: Array<{ page: number; lines: Array<{ text?: string }> }> };

    // If .md is available, use it (has images in correct positions)
    // Strategy: use .lines.json to know how many lines per page,
    // then distribute the .md content proportionally
    if (mdRes.ok) {
      const fullMd = await mdRes.text();

      // If only 1 page, just return the whole .md
      if (data.pages.length === 1) {
        const cleaned = fullMd.split('\n')
          .filter(l => !l.startsWith('[^'))
          .join('\n').trim();
        return [cleaned];
      }

      // For multi-page: use page-specific text signatures to find split points
      // Each page in lines.json has unique text — find where that text appears in .md
      const mdText = fullMd;
      const pageBreakPositions: number[] = [0]; // char positions where each page starts

      for (let p = 1; p < data.pages.length; p++) {
        const page = data.pages[p];
        // Use the first 2-3 lines combined as a signature
        const sigLines = page.lines.slice(0, 3).map(l => l.text?.trim()).filter(Boolean);

        let bestPos = -1;
        for (const sig of sigLines) {
          if (!sig || sig.length < 10) continue;
          // Search for this signature text in the .md, after the previous page break
          const searchFrom = pageBreakPositions[pageBreakPositions.length - 1] + 50;
          const idx = mdText.indexOf(sig, searchFrom);
          if (idx > 0) {
            // Find the start of the line containing this text
            const lineStart = mdText.lastIndexOf('\n', idx);
            bestPos = lineStart > 0 ? lineStart : idx;
            break;
          }
        }

        if (bestPos > 0) {
          pageBreakPositions.push(bestPos);
        } else {
          // Fallback: distribute evenly
          const avgChars = mdText.length / data.pages.length;
          pageBreakPositions.push(Math.round(avgChars * p));
        }
      }

      // Split .md into pages
      const pages: string[] = [];
      for (let i = 0; i < pageBreakPositions.length; i++) {
        const start = pageBreakPositions[i];
        const end = i + 1 < pageBreakPositions.length ? pageBreakPositions[i + 1] : mdText.length;
        const pageText = mdText.slice(start, end)
          .split('\n')
          .filter(l => !l.startsWith('[^'))
          .join('\n')
          .trim();
        pages.push(pageText);
      }

      return pages;
    }

    // Fallback: lines.json only (no images)
    return data.pages.map(page =>
      page.lines.map(line => line.text ?? '').join('\n')
    );
  },

  /**
   * Convert a single page image to rich Markdown using Mathpix.
   * Fallback for when PDF endpoint isn't suitable.
   */
  async convertPageToMarkdown(imageBuffer: Buffer): Promise<string> {
    if (!this.isConfigured()) throw new Error('Mathpix not configured');

    const base64 = imageBuffer.toString('base64');
    const res = await fetch('https://api.mathpix.com/v3/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'app_id': config.MATHPIX_APP_ID,
        'app_key': config.MATHPIX_APP_KEY,
      },
      body: JSON.stringify({
        src: `data:image/png;base64,${base64}`,
        formats: ['text', 'html'],
        data_options: {
          include_latex: true,
          include_table_html: true,
        },
        enable_tables_fallback: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Mathpix error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return data.text ?? data.html ?? '';
  },

  /** Batch convert multiple image regions to LaTeX */
  async batchConvertRegions(regions: MathRegion[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const CONCURRENCY = 5;

    for (let i = 0; i < regions.length; i += CONCURRENCY) {
      const batch = regions.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (region) => {
        const latex = await this.convertImageToLatex(region.imageBuffer);
        results.set(region.id, latex);
      });
      await Promise.all(promises);
    }

    return results;
  },
};
