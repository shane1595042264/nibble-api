import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { parseTocSuggestions } from '../../../src/lib/toc-suggestions.js';
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
