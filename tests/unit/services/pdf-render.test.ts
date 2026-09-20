import { describe, it, expect } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash } from 'crypto';
import { pdfService } from '../../../src/services/pdf.service.js';

/**
 * KAN-315: pdfjs-dist 5 resolves page.render() without drawing anything when the
 * canvas backend is node-canvas, so every rendered page came back uniform white.
 * These tests pin the raster actually carrying ink.
 */

/** Build a single-page 400x300 PDF whose content stream is `ops`. */
function buildPdf(ops: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'binary');
}

/** Decode a PNG and count pixels that are neither transparent nor (near-)white. */
async function countInkPixels(png: Buffer): Promise<{ ink: number; total: number }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);

  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) ink++;
  }
  return { ink, total: image.width * image.height };
}

const FULL_PAGE_BLACK = '0 0 0 rg\n0 0 400 300 re\nf';
const SMALL_BLACK_SQUARE = '0 0 0 rg\n10 10 40 40 re\nf';

describe('pdfService.renderPageToImage', () => {
  it('renders a full-page black fill as a fully inked raster', async () => {
    const png = await pdfService.renderPageToImage(buildPdf(FULL_PAGE_BLACK), 1, 2.0);
    const { ink, total } = await countInkPixels(png);

    // Pre-fix (node-canvas backend) this was 0 of 480000.
    expect(total).toBe(800 * 600);
    expect(ink).toBe(total);
  });

  it('does not render two visually different pages to identical bytes', async () => {
    const full = await pdfService.renderPageToImage(buildPdf(FULL_PAGE_BLACK), 1, 2.0);
    const square = await pdfService.renderPageToImage(buildPdf(SMALL_BLACK_SQUARE), 1, 2.0);

    const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    expect(sha(full)).not.toBe(sha(square));

    const { ink } = await countInkPixels(square);
    expect(ink).toBeGreaterThan(0);
    expect(ink).toBeLessThan(800 * 600);
  });

  it('throws instead of returning a blank raster', async () => {
    // An empty content stream draws nothing — the exact shape of the silent
    // failure this guard exists to surface.
    await expect(pdfService.renderPageToImage(buildPdf(''), 1, 2.0)).rejects.toThrow(
      /blank raster/,
    );
  });
});
