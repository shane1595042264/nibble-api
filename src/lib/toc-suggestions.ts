import { AppError } from './errors.js';

export interface TocSuggestionSection {
  title: string;
  startPage: number;
  endPage: number;
}

export interface TocSuggestionChapter extends TocSuggestionSection {
  sections?: TocSuggestionSection[];
}

export interface TocSuggestions {
  chapters: TocSuggestionChapter[];
}

/**
 * Turn Claude's raw TOC reply into a validated { chapters } object.
 *
 * Every failure here is the MODEL's fault, not the caller's, so every one of them
 * has to leave as AI_ERROR/502 — the same class as the existing 'No text response
 * from Claude' throw. Two wrong-blame bugs this exists to prevent (KAN-313):
 *
 *  - A bare JSON.parse on a truncated reply throws SyntaxError, which
 *    error-handler.ts maps to 400 VALIDATION_ERROR 'Invalid JSON body' on the
 *    assumption that any SyntaxError came from c.req.json(). The caller's body was
 *    already validated clean by safeParse, so that tells the client its request was
 *    malformed when the malformed thing is the model's response.
 *  - Iterating `suggestions.chapters` unchecked turns well-formed JSON of the wrong
 *    shape into 'undefined is not iterable' -> opaque 500 INTERNAL_ERROR.
 */
export function parseTocSuggestions(rawText: string, stopReason?: string | null): TocSuggestions {
  // Checked BEFORE parsing: a max_tokens stop means the JSON is cut mid-token, so the
  // SyntaxError below would be a true but useless description of the real problem.
  if (stopReason === 'max_tokens') {
    throw new AppError(
      'AI_ERROR',
      'The AI ran out of room before it finished reading this table of contents. Select fewer TOC pages and try again.',
      502
    );
  }

  let jsonStr = rawText.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new AppError(
      'AI_ERROR',
      'The AI returned a malformed response for this table of contents. Try again, or select fewer TOC pages.',
      502
    );
  }

  const chapters = (parsed as { chapters?: unknown } | null)?.chapters;
  if (!Array.isArray(chapters)) {
    throw new AppError(
      'AI_ERROR',
      'The AI returned an unexpected response shape for this table of contents. Try again, or select different TOC pages.',
      502
    );
  }

  return { chapters: chapters as TocSuggestionChapter[] };
}

export type TocPageOffsetSource = 'labels' | 'titles' | 'none';

export interface TocPageOffset {
  pageOffset: number;
  pageOffsetSource: TocPageOffsetSource;
}

/** Lowercase, drop accents and everything but letters/digits. pdf.js text joins items
 * with spaces wherever the PDF breaks a run, so spacing can't be trusted. */
function normalizeForMatch(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Strings to look for on a chapter's opening page: the title as the TOC prints it,
 * and the title without its "Chapter 3:" / "3." numbering, which the opening page
 * often sets on its own line or drops. Too-short needles match ordinary prose. */
function titleNeedles(title: string): string[] {
  const last = title.split('>').pop()!.trim();
  const needles = new Set<string>();
  const full = normalizeForMatch(last);
  if (full.length >= 6) needles.add(full);
  const bare = normalizeForMatch(last.replace(/^(?:(?:chapter|part|section)\s+)?[\divxlc]+[.:)\-\s]+/i, ''));
  if (bare.length >= 6) needles.add(bare);
  return [...needles];
}

/**
 * Work out how far the book's printed page numbers sit from its PDF page indexes.
 * The TOC (and so every startPage in a suggestion) uses printed numbers, but dividers
 * are PDF pages, and front matter (cover, copyright, preface, the TOC itself) puts
 * printed page 1 N pages in. KAN-410.
 *
 * 1. /PageLabels, when the PDF has them: the page labelled "1" is printed page 1.
 * 2. Otherwise read the pages after the TOC for the opening page of the first few
 *    entries; pageOffset is the found page minus the printed one, most common wins.
 *    A page naming two or more of the titles is more TOC, not a chapter opening.
 * 3. Nothing found: 0, which is what the client did before this existed.
 */
export async function detectTocPageOffset(opts: {
  chapters: TocSuggestionChapter[];
  pageLabels: string[] | null;
  numPages: number;
  firstSearchPage: number;
  getPageText: (pageNumber: number) => Promise<string>;
  maxPagesToScan?: number;
  maxEntries?: number;
}): Promise<TocPageOffset> {
  const { chapters, pageLabels, numPages, firstSearchPage, getPageText } = opts;

  if (Array.isArray(pageLabels)) {
    const index = pageLabels.findIndex((label) => typeof label === 'string' && label.trim() === '1');
    if (index >= 0) return { pageOffset: index, pageOffsetSource: 'labels' };
  }

  const entries = chapters
    .filter((ch) => ch && typeof ch.title === 'string' && Number.isInteger(ch.startPage))
    .map((ch) => ({ startPage: ch.startPage, needles: titleNeedles(ch.title) }))
    .filter((e) => e.needles.length > 0)
    .slice(0, opts.maxEntries ?? 5);
  if (entries.length === 0) return { pageOffset: 0, pageOffsetSource: 'none' };

  const lastPage = Math.min(numPages, firstSearchPage + (opts.maxPagesToScan ?? 150) - 1);
  const offsets: number[] = [];
  const found = new Set<number>();
  for (let page = Math.max(1, firstSearchPage); page <= lastPage && found.size < Math.min(3, entries.length); page++) {
    let text: string;
    try {
      text = normalizeForMatch(await getPageText(page));
    } catch {
      continue;
    }
    if (!text) continue;
    const hits = entries
      .map((e, i) => (e.needles.some((n) => text.includes(n)) ? i : -1))
      .filter((i) => i >= 0);
    if (hits.length !== 1 || found.has(hits[0])) continue;
    const entry = entries[hits[0]];
    found.add(hits[0]);
    offsets.push(page - entry.startPage);
  }
  if (offsets.length === 0) return { pageOffset: 0, pageOffsetSource: 'none' };

  // Most common offset; a tie goes to the entry found first.
  const counts = new Map<number, number>();
  for (const o of offsets) counts.set(o, (counts.get(o) ?? 0) + 1);
  let best = offsets[0];
  for (const o of offsets) if (counts.get(o)! > counts.get(best)!) best = o;
  return { pageOffset: best, pageOffsetSource: 'titles' };
}
