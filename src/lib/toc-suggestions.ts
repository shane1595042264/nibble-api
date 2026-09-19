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
