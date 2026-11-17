/**
 * Lets sync.service (which saves new vocabulary) wake the knowledge-base
 * forwarder (src/jobs/kb-forward.ts) without importing it. The forwarder needs
 * the database, and sync.service's unit tests load sync.service with every
 * repository mocked, so a direct import would drag a real Postgres client in.
 * Before the forwarder starts (and in tests) nothing is listening and the
 * signal is a no-op: the forwarder's periodic sweep picks the words up anyway.
 */
let listener: (() => void) | null = null;

export function onNewVocabSaved(fn: (() => void) | null): void {
  listener = fn;
}

export function notifyNewVocabSaved(): void {
  try {
    listener?.();
  } catch (err) {
    // A wake-up must never fail the sync request that triggered it.
    console.error('[kb-forward] wake-up failed:', err);
  }
}
