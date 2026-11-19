import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { parseTocSuggestions, detectTocPageOffset } from '../../../src/lib/toc-suggestions.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

// POST /books/:id/suggest-structure used to hand Claude's raw reply to a bare
// JSON.parse and then iterate `.chapters` unchecked, inside a try/finally with no
// catch. A truncated reply therefore surfaced as 400 VALIDATION_ERROR 'Invalid JSON
// body' (error-handler treats every SyntaxError as a c.req.json() failure) and a
// wrong-shape reply as 500 INTERNAL_ERROR — both blaming the caller, whose request
// had already passed safeParse. These assert the model's faults classify as the
// model's faults. KAN-313.

/** Run a thrown error through the real error handler to get the wire response. */
async function wireResponse(fn: () => unknown) {
  const app = new Hono();
  app.onError(errorHandler);
  app.get('/t', (c) => c.json(fn() as object));
  const res = await app.request('/t');
  return { status: res.status, body: await res.json() as { error: { code: string; message: string } } };
}

describe('parseTocSuggestions', () => {
  it('parses a flat TOC reply', () => {
    const out = parseTocSuggestions('{"chapters":[{"title":"Intro","startPage":1,"endPage":14}]}');
    expect(out.chapters).toEqual([{ title: 'Intro', startPage: 1, endPage: 14 }]);
  });

  it('parses nested sections and strips markdown fences', () => {
    const fenced = '```json\n{"chapters":[{"title":"Part I","startPage":3,"endPage":40,"sections":[{"title":"Basics","startPage":3,"endPage":19}]}]}\n```';
    const out = parseTocSuggestions(fenced);
    expect(out.chapters[0].sections).toEqual([{ title: 'Basics', startPage: 3, endPage: 19 }]);
  });

  it('accepts an empty chapter list (the UI has its own message for it)', () => {
    expect(parseTocSuggestions('{"chapters":[]}').chapters).toEqual([]);
  });

  it('reports a max_tokens stop as truncation, before parsing', async () => {
    // Truncated mid-object: the JSON is invalid too, but stop_reason is the real story.
    const truncated = '{"chapters":[{"title":"Intro","startPage":1,"endPage":14},{"title":"Met';
    const { status, body } = await wireResponse(() => parseTocSuggestions(truncated, 'max_tokens'));
    expect(status).toBe(502);
    expect(body.error.code).toBe('AI_ERROR');
    expect(body.error.message).toMatch(/fewer TOC pages/i);
  });

  it('turns a truncated reply into 502 AI_ERROR, not 400 Invalid JSON body', async () => {
    const truncated = '{"chapters":[{"title":"Intro","startPage":1,"endPa';
    const { status, body } = await wireResponse(() => parseTocSuggestions(truncated, 'end_turn'));
    expect(status).toBe(502);
    expect(body.error.code).toBe('AI_ERROR');
    expect(body.error.message).not.toBe('Invalid JSON body');
  });

  it.each([
    ['a bare array', '[{"title":"Intro","startPage":1,"endPage":14}]'],
    ['a different key', '{"toc":[{"title":"Intro","startPage":1,"endPage":14}]}'],
    ['chapters as an object', '{"chapters":{"0":{"title":"Intro"}}}'],
    ['null', 'null'],
  ])('turns well-formed JSON of the wrong shape (%s) into 502 AI_ERROR, not 500', async (_label, raw) => {
    const { status, body } = await wireResponse(() => parseTocSuggestions(raw, 'end_turn'));
    expect(status).toBe(502);
    expect(body.error.code).toBe('AI_ERROR');
    expect(body.error.message).not.toBe('Internal server error');
  });
});

// The TOC lists PRINTED page numbers; dividers are PDF pages. A book with 14 pages of
// front matter has printed page 1 on PDF page 15, and Process TOC put every divider
// 14 pages early. KAN-410.
describe('detectTocPageOffset', () => {
  const chapters = [
    { title: 'Chapter 1: Getting Started', startPage: 1, endPage: 19 },
    { title: 'Chapter 2: Methods of Analysis', startPage: 20, endPage: 40 },
    { title: 'Chapter 3: Results and Discussion', startPage: 41, endPage: 60 },
  ];

  /** A 80-page book: pages listed in `pages` carry that text, the rest are prose. */
  function book(pages: Record<number, string>) {
    const reads: number[] = [];
    return {
      reads,
      getPageText: async (n: number) => { reads.push(n); return pages[n] ?? 'Some ordinary body text on this page.'; },
    };
  }

  it('reads the offset from /PageLabels when a page is labelled 1', async () => {
    const labels = ['Cover', 'i', 'ii', 'iii', 'iv', '1', '2', '3'];
    const { reads, getPageText } = book({});
    const out = await detectTocPageOffset({ chapters, pageLabels: labels, numPages: 8, firstSearchPage: 4, getPageText });
    expect(out).toEqual({ pageOffset: 5, pageOffsetSource: 'labels' });
    expect(reads).toEqual([]);
  });

  it('finds the chapter openings after the TOC when there are no labels', async () => {
    const { getPageText } = book({
      15: 'CHAPTER 1 Getting  Started   Lorem ipsum',
      34: 'Chapter 2 Methods of Analysis',
      55: 'Results and Discussion',
    });
    const out = await detectTocPageOffset({ chapters, pageLabels: null, numPages: 80, firstSearchPage: 5, getPageText });
    expect(out).toEqual({ pageOffset: 14, pageOffsetSource: 'titles' });
  });

  it('skips a TOC page the reader did not select (it names several titles)', async () => {
    const { getPageText } = book({
      5: 'Chapter 2: Methods of Analysis .... 20   Chapter 3: Results and Discussion .... 41',
      15: 'Getting Started',
      34: 'Methods of Analysis',
    });
    const out = await detectTocPageOffset({ chapters, pageLabels: null, numPages: 80, firstSearchPage: 5, getPageText });
    expect(out).toEqual({ pageOffset: 14, pageOffsetSource: 'titles' });
  });

  it('lets the most common offset outvote a stray mention', async () => {
    const { getPageText } = book({
      8: 'In the preface we say Methods of Analysis matters',
      15: 'Getting Started',
      55: 'Results and Discussion',
    });
    const out = await detectTocPageOffset({ chapters, pageLabels: null, numPages: 80, firstSearchPage: 5, getPageText });
    expect(out.pageOffset).toBe(14);
  });

  it('falls back to 0 when nothing matches (scanned book, no labels)', async () => {
    const out = await detectTocPageOffset({
      chapters, pageLabels: [], numPages: 80, firstSearchPage: 5, getPageText: async () => '',
    });
    expect(out).toEqual({ pageOffset: 0, pageOffsetSource: 'none' });
  });

  it('keeps offset 0 for a book whose printed pages are its PDF pages (control)', async () => {
    const { getPageText } = book({ 1: 'Getting Started', 20: 'Methods of Analysis', 41: 'Results and Discussion' });
    const out = await detectTocPageOffset({ chapters, pageLabels: null, numPages: 80, firstSearchPage: 1, getPageText });
    expect(out).toEqual({ pageOffset: 0, pageOffsetSource: 'titles' });
  });

  it('survives a page whose text cannot be read', async () => {
    const out = await detectTocPageOffset({
      chapters, pageLabels: null, numPages: 80, firstSearchPage: 5,
      getPageText: async (n) => { if (n === 6) throw new Error('bad page'); return n === 15 ? 'Getting Started' : ''; },
    });
    expect(out).toEqual({ pageOffset: 14, pageOffsetSource: 'titles' });
  });
});
