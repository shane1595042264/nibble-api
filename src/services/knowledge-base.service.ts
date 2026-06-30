/**
 * Forwards vocab captures from Nibbler into the personal-website knowledge base
 * (POST /api/knowledge/notes). The personal-website API is the sole source of
 * truth for vocab now — we stopped writing to the local `vocabulary` table on
 * 2026-05-16 in favour of this forward.
 */
import { config } from '../lib/config.js';
import { AppError } from '../lib/errors.js';

/**
 * Short bound for the outbound KB forward. This runs on the INTERACTIVE sync
 * path (POST /api/sync, awaited sequentially per new word), so it must fail
 * fast — not block the whole request behind a hung upstream. Mirrors the
 * AbortSignal.timeout convention introduced for Mathpix in mathpix.service.ts.
 */
const KNOWLEDGE_BASE_TIMEOUT_MS = 10_000;

function isAbortTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export interface VocabForwardInput {
  word: string;
  pronunciation?: string;
  translation?: string;
  targetLanguage?: string;
  definition?: string;
  contextSentence?: string;
  explanation?: string;
  bookTitle?: string;
  sectionTitle?: string;
  page?: number;
}

export interface KnowledgeBaseEntry {
  id: string;
  word: string;
  language: string;
  category: string;
  definition: string | null;
  pronunciation: string | null;
  partOfSpeech: string | null;
  exampleSentence: string | null;
  labels: string[];
  source: {
    app: string | null;
    book: string | null;
    author: string | null;
    location: string | null;
    rawContext: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Compose the free-text the knowledge-base classifier will see. We bundle the
 * key structured fields into a sentence the classifier already understands
 * (matches the prompt examples in shaneBackend/src/modules/knowledge/classifier.ts).
 */
export function buildKnowledgeText(input: VocabForwardInput): string {
  const parts: string[] = [];
  const word = input.word;
  const translation = input.translation ?? input.definition ?? '';

  if (translation) {
    parts.push(`"${word}" means "${translation}"`);
  } else {
    parts.push(`"${word}"`);
  }

  if (input.targetLanguage) {
    parts.push(`(target language: ${input.targetLanguage})`);
  }

  if (input.pronunciation) {
    parts.push(`pronounced [${input.pronunciation}]`);
  }

  if (input.contextSentence) {
    parts.push(`Context: "${input.contextSentence}"`);
  }

  if (input.explanation) {
    parts.push(`Note: ${input.explanation}`);
  }

  return parts.join('. ');
}

/**
 * Build the source object so the knowledge base can later trace each entry
 * back to the book/section/page it was captured from inside Nibbler.
 */
export function buildKnowledgeSource(input: VocabForwardInput): Record<string, string | null> | null {
  const book = input.bookTitle?.trim() || null;
  const section = input.sectionTitle?.trim() || null;
  const page = input.page ? `page ${input.page}` : null;
  const location = [section, page].filter(Boolean).join(', ') || null;
  const rawContext = input.contextSentence?.trim() || null;

  // Always at least app=nibbler so caller can audit "what came from where".
  return {
    app: 'nibbler',
    book,
    author: null,
    location,
    rawContext,
  };
}

/**
 * POST a vocab entry to the personal-website knowledge base.
 * Throws AppError on misconfiguration or upstream failure so the caller can
 * surface the right HTTP status to the frontend.
 */
export async function forwardVocabToKnowledgeBase(
  input: VocabForwardInput,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = KNOWLEDGE_BASE_TIMEOUT_MS
): Promise<KnowledgeBaseEntry> {
  if (!config.KNOWLEDGE_BASE_PAT) {
    throw new AppError(
      'KNOWLEDGE_BASE_NOT_CONFIGURED',
      'Knowledge base PAT is not configured on the server',
      503
    );
  }

  const body = {
    text: buildKnowledgeText(input),
    source: buildKnowledgeSource(input),
  };

  let res: Response;
  try {
    res = await fetchImpl(`${config.KNOWLEDGE_BASE_URL}/api/knowledge/notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.KNOWLEDGE_BASE_PAT}`,
      },
      body: JSON.stringify(body),
      // Without this, a hung KB never throws and never reaches the caller's
      // catch (sync.service.ts:379) — it just stalls the whole POST /api/sync
      // request indefinitely. A timeout turns the hang into a thrown error so
      // the existing failedEntities retry path fires.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isAbortTimeout(err)) {
      // 502 (treated like an upstream 5xx) so the caller's catch pushes this
      // word to failedEntities.vocabulary and the client retries next sync.
      throw new AppError(
        'KNOWLEDGE_BASE_TIMEOUT',
        `Knowledge base did not respond within ${timeoutMs}ms`,
        502
      );
    }
    throw err;
  }

  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      detail = text ? `: ${text.slice(0, 500)}` : '';
    } catch {
      // ignore
    }
    throw new AppError(
      'KNOWLEDGE_BASE_FORWARD_FAILED',
      `Knowledge base rejected vocab push (status ${res.status})${detail}`,
      // 429 and 5xx upstream stays as 5xx to the caller; 4xx propagates as 400.
      res.status >= 500 || res.status === 429 ? 502 : 400
    );
  }

  const payload = (await res.json()) as { entries?: KnowledgeBaseEntry[] };
  const entry = payload.entries?.[0];
  if (!entry) {
    // A 2xx with no entries means the knowledge base accepted the request but
    // created nothing new — i.e. it DEDUPED a word it already has. The goal of
    // this forward is "ensure the word reaches the KB", so a dedup is success,
    // not failure. Throwing here previously pushed the word onto
    // failedEntities.vocabulary, which made the WordByWord client bump
    // updatedAt and re-forward the same word on every sync forever (the
    // "sync partial — N items will retry" loop). Return a best-effort entry
    // synthesized from the input so the caller proceeds to the local insert and
    // clears the dirty flag. The synthetic id is never used by the sync path
    // (the local PG row keeps the client's own id) and the KB has no GET to
    // recover the real one.
    return {
      id: '',
      word: input.word,
      language: input.targetLanguage ?? 'unknown',
      category: 'vocabulary',
      definition: input.definition ?? input.translation ?? null,
      pronunciation: input.pronunciation ?? null,
      partOfSpeech: null,
      exampleSentence: input.contextSentence ?? null,
      labels: [],
      source: buildKnowledgeSource(input) as KnowledgeBaseEntry['source'],
      createdAt: '',
      updatedAt: '',
    };
  }
  return entry;
}

/**
 * Map a knowledge-base entry back to the shape the WordByWord frontend's
 * sync service expects from the legacy POST /api/vocabulary handler. The
 * frontend keys off `id` and `updatedAt`; everything else is best-effort.
 */
export function knowledgeEntryToLegacyVocab(entry: KnowledgeBaseEntry, input: VocabForwardInput) {
  return {
    id: entry.id,
    userId: null,
    bookId: null,
    word: entry.word,
    pronunciation: entry.pronunciation,
    translation: input.translation ?? null,
    targetLanguage: input.targetLanguage ?? entry.language ?? null,
    definition: entry.definition,
    contextSentence: input.contextSentence ?? entry.source?.rawContext ?? null,
    explanation: input.explanation ?? null,
    bookTitle: input.bookTitle ?? entry.source?.book ?? null,
    sectionTitle: input.sectionTitle ?? null,
    page: input.page ?? null,
    reviewCount: 0,
    lastReviewedAt: null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: null,
  };
}
