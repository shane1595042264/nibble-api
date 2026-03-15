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
   * Convert a page image to rich Markdown using Mathpix.
   * Returns Markdown with:
   * - Tables as proper Markdown tables
   * - LaTeX formulas as $...$ / $$...$$
   * - Text with formatting preserved
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
    // Prefer text format (Markdown-like with LaTeX), fall back to HTML
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
