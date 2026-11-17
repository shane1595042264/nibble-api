/**
 * Knowledge-base forward outbox.
 *
 * Every new vocabulary word must reach the personal-website knowledge base
 * (the user-facing source of truth since 2026-05-16). Until 2026-11-17 that
 * forward ran inline in POST /api/sync with a 10s timeout; the KB classifies
 * each note with an AI call and sometimes takes longer, so the word was pushed
 * onto failedEntities, the client showed "Sync failed", and the retry depended
 * on a browser tab staying open.
 *
 * Now sync saves the word with kb_forwarded_at NULL ("owed") and this job
 * forwards it: woken right after a sync that saved new words, and on a sweep
 * every minute. A failure backs off exponentially (30s doubling, capped at 6h)
 * and is retried forever; the error is kept in kb_last_error.
 *
 * Concurrency: each word is claimed with a lease (kb_next_attempt_at pushed
 * past the forward timeout) under FOR UPDATE SKIP LOCKED, so two instances
 * (e.g. old and new container during a deploy) never forward the same word at
 * once. A forward that succeeds but fails to be recorded is re-sent after the
 * lease; the KB treats that as a dedup (2xx, no entries), which counts as
 * success. All writes are raw SQL so updated_at never moves: these columns are
 * server bookkeeping and must not make the word re-sync to every device.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { forwardVocabToKnowledgeBase, type VocabForwardInput } from '../services/knowledge-base.service.js';
import { onNewVocabSaved } from './kb-forward-signal.js';

/** Words forwarded per run, so one run can't hold the job for long. */
export const KB_FORWARD_BATCH = 20;
/** No user is waiting on this request any more, so the KB gets longer than the old 10s. */
export const KB_FORWARD_TIMEOUT_MS = 30_000;
/** A claim outlives one forward attempt by a margin, then the word is claimable again. */
export const KB_FORWARD_LEASE_MS = KB_FORWARD_TIMEOUT_MS + 60_000;
export const KB_FORWARD_SWEEP_MS = 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
/** Groups the wake-ups from one sync (and bursts of syncs) into one run. */
const WAKE_DELAY_MS = 250;

/** Delay before the next try after `attempts` failures (1 → 30s, 2 → 60s, … ≤ 6h). */
export function kbRetryDelayMs(attempts: number): number {
  const exp = BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, MAX_BACKOFF_MS);
}

export interface OwedWord {
  id: string;
  /** Failures so far, before this attempt. */
  attempts: number;
  input: VocabForwardInput;
}

export interface KbOutboxStore {
  /** Claim the oldest owed word whose turn has come, leasing it for `leaseMs`. */
  claimNext(leaseMs: number): Promise<OwedWord | null>;
  markForwarded(id: string): Promise<void>;
  markFailed(id: string, attempts: number, retryInMs: number, error: string): Promise<void>;
}

export type KbForwardFn = (input: VocabForwardInput, timeoutMs: number) => Promise<unknown>;

/** The forwarding loop, with its storage and network injected (tests drive it directly). */
export function createKbForwarder(store: KbOutboxStore, forward: KbForwardFn) {
  let running = false;
  let rerun = false;

  async function forwardOne(word: OwedWord): Promise<void> {
    try {
      await forward(word.input, KB_FORWARD_TIMEOUT_MS);
    } catch (err) {
      const attempts = word.attempts + 1;
      const retryIn = kbRetryDelayMs(attempts);
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[kb-forward] ${word.id} attempt ${attempts} failed, retrying in ${Math.round(retryIn / 1000)}s: ${message}`,
      );
      await store.markFailed(word.id, attempts, retryIn, message.slice(0, 500));
      return;
    }
    await store.markForwarded(word.id);
    if (word.attempts > 0) console.log(`[kb-forward] ${word.id} forwarded after ${word.attempts} failed attempt(s)`);
  }

  /** Forward up to KB_FORWARD_BATCH owed words. Overlapping calls fold into one rerun. */
  async function run(): Promise<void> {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        for (let i = 0; i < KB_FORWARD_BATCH; i++) {
          const word = await store.claimNext(KB_FORWARD_LEASE_MS);
          if (!word) break;
          await forwardOne(word);
        }
      } while (rerun);
    } catch (err) {
      // Database trouble: the claimed word (if any) keeps its lease and the
      // next sweep tries again.
      console.error('[kb-forward] run failed:', err);
    } finally {
      running = false;
    }
  }

  return { run };
}

type OwedRow = {
  id: string;
  word: string;
  pronunciation: string | null;
  translation: string | null;
  target_language: string | null;
  definition: string | null;
  context_sentence: string | null;
  explanation: string | null;
  book_title: string | null;
  section_title: string | null;
  page: number | null;
  kb_forward_attempts: number;
};

const orUndefined = <T>(v: T | null): T | undefined => (v == null ? undefined : v);

/** Postgres-backed outbox over the vocabulary table. */
export const pgKbOutboxStore: KbOutboxStore = {
  async claimNext(leaseMs) {
    const rows = (await db.execute(sql`
      UPDATE vocabulary
         SET kb_next_attempt_at = now() + make_interval(secs => ${leaseMs / 1000})
       WHERE id = (
         SELECT id FROM vocabulary
          WHERE kb_forwarded_at IS NULL
            AND deleted_at IS NULL
            AND (kb_next_attempt_at IS NULL OR kb_next_attempt_at <= now())
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, word, pronunciation, translation, target_language, definition,
                context_sentence, explanation, book_title, section_title, page,
                kb_forward_attempts
    `)) as unknown as OwedRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      attempts: row.kb_forward_attempts,
      input: {
        word: row.word,
        pronunciation: orUndefined(row.pronunciation),
        translation: orUndefined(row.translation),
        targetLanguage: orUndefined(row.target_language),
        definition: orUndefined(row.definition),
        contextSentence: orUndefined(row.context_sentence),
        explanation: orUndefined(row.explanation),
        bookTitle: orUndefined(row.book_title),
        sectionTitle: orUndefined(row.section_title),
        page: orUndefined(row.page),
      },
    };
  },

  async markForwarded(id) {
    await db.execute(sql`
      UPDATE vocabulary
         SET kb_forwarded_at = now(), kb_next_attempt_at = NULL, kb_last_error = NULL
       WHERE id = ${id}
    `);
  },

  async markFailed(id, attempts, retryInMs, error) {
    await db.execute(sql`
      UPDATE vocabulary
         SET kb_forward_attempts = ${attempts},
             kb_next_attempt_at = now() + make_interval(secs => ${retryInMs / 1000}),
             kb_last_error = ${error}
       WHERE id = ${id}
    `);
  },
};

let started = false;

/** Start the sweep and listen for sync's wake-ups. Called once from index.ts. */
export function startKnowledgeBaseForwarder(): void {
  if (started) return;
  started = true;
  const forwarder = createKbForwarder(pgKbOutboxStore, (input, timeoutMs) =>
    forwardVocabToKnowledgeBase(input, fetch, timeoutMs),
  );
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  onNewVocabSaved(() => {
    if (wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void forwarder.run();
    }, WAKE_DELAY_MS);
  });
  setInterval(() => void forwarder.run(), KB_FORWARD_SWEEP_MS);
  void forwarder.run(); // anything left over from before this process started
}
