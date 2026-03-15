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

    // Step 3: Download both per-page lines AND full .md (for images)
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

    // Extract image URLs from .md (lines.json doesn't include them)
    let imageUrls: string[] = [];
    if (mdRes.ok) {
      const fullMd = await mdRes.text();
      const imgMatches = fullMd.match(/!\[.*?\]\(https:\/\/cdn\.mathpix\.com\/cropped\/[^)]+\)/g);
      imageUrls = imgMatches ?? [];
    }

    // Build Markdown per page from lines, injecting images where "Figure X.X" is referenced
    const pages = data.pages.map(page => {
      let pageText = page.lines.map(line => line.text ?? '').join('\n');

      // For each image URL, check if this page references the corresponding figure
      // Mathpix image URLs contain page info: pdf_id-{pageNum}.jpg
      for (const imgMd of imageUrls) {
        // Extract page number from URL: ...pdf_id-1.jpg means page 1
        const pageMatch = imgMd.match(/-(\d+)\.jpg/);
        if (pageMatch && parseInt(pageMatch[1]) === page.page) {
          // Inject the image markdown at the end of the page text
          pageText += '\n\n' + imgMd;
        }
      }

      return pageText;
    });

    return pages;
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
