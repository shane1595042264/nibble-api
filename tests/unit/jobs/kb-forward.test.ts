import { describe, it, expect, vi, beforeEach } from 'vitest';

// The forwarding loop is tested with its storage and network injected; the
// SQL behind pgKbOutboxStore was exercised against Postgres separately. These
// mocks only keep the module's imports from opening a real connection.
vi.mock('../../../src/db/index.js', () => ({ db: {} }));
vi.mock('../../../src/services/knowledge-base.service.js', () => ({ forwardVocabToKnowledgeBase: vi.fn() }));

const { createKbForwarder, kbRetryDelayMs, KB_FORWARD_BATCH, KB_FORWARD_TIMEOUT_MS, KB_FORWARD_LEASE_MS } = await import(
  '../../../src/jobs/kb-forward.js'
);
type Store = import('../../../src/jobs/kb-forward.js').KbOutboxStore;
type Owed = import('../../../src/jobs/kb-forward.js').OwedWord;

const owed = (id: string, attempts = 0): Owed => ({ id, attempts, input: { word: `word-${id}` } });

/** An in-memory outbox: claimNext hands out the queued words in order. */
function memoryStore(words: Owed[]) {
  const queue = [...words];
  const store = {
    claimNext: vi.fn(async (_leaseMs: number) => queue.shift() ?? null),
    markForwarded: vi.fn(async (_id: string) => {}),
    markFailed: vi.fn(async (_id: string, _attempts: number, _retryIn: number, _error: string) => {}),
  } satisfies Store;
  return store;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('kbRetryDelayMs', () => {
  it('starts at 30s, doubles, and caps at 6 hours', () => {
    expect(kbRetryDelayMs(1)).toBe(30_000);
    expect(kbRetryDelayMs(2)).toBe(60_000);
    expect(kbRetryDelayMs(3)).toBe(120_000);
    expect(kbRetryDelayMs(12)).toBe(6 * 60 * 60_000);
    expect(kbRetryDelayMs(500)).toBe(6 * 60 * 60_000);
  });
});

describe('createKbForwarder().run', () => {
  it('forwards every owed word with the longer background timeout and marks each forwarded', async () => {
    const store = memoryStore([owed('a'), owed('b')]);
    const forward = vi.fn(async () => ({}));

    await createKbForwarder(store, forward).run();

    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenCalledWith({ word: 'word-a' }, KB_FORWARD_TIMEOUT_MS);
    expect(store.markForwarded.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('claims with a lease longer than one forward attempt', async () => {
    const store = memoryStore([owed('a')]);
    await createKbForwarder(store, vi.fn(async () => ({}))).run();

    expect(store.claimNext).toHaveBeenCalledWith(KB_FORWARD_LEASE_MS);
    expect(KB_FORWARD_LEASE_MS).toBeGreaterThan(KB_FORWARD_TIMEOUT_MS);
  });

  it('records a failure with the next attempt count and backoff, then moves on to the next word', async () => {
    const store = memoryStore([owed('slow', 2), owed('fine')]);
    const forward = vi.fn(async (input: { word: string }) => {
      if (input.word === 'word-slow') throw new Error('Knowledge base did not respond within 30000ms');
      return {};
    });

    await createKbForwarder(store, forward).run();

    expect(store.markFailed).toHaveBeenCalledWith('slow', 3, kbRetryDelayMs(3), 'Knowledge base did not respond within 30000ms');
    expect(store.markForwarded.mock.calls.map(([id]) => id)).toEqual(['fine']);
  });

  it('caps a stored error at 500 characters', async () => {
    const store = memoryStore([owed('a')]);
    await createKbForwarder(store, vi.fn(async () => { throw new Error('x'.repeat(2000)); })).run();

    expect(store.markFailed.mock.calls[0][3]).toHaveLength(500);
  });

  it('forwards at most one batch per run', async () => {
    const store = memoryStore(Array.from({ length: KB_FORWARD_BATCH + 5 }, (_, i) => owed(`w${i}`)));
    const forward = vi.fn(async () => ({}));

    await createKbForwarder(store, forward).run();

    expect(forward).toHaveBeenCalledTimes(KB_FORWARD_BATCH);
  });

  it('folds a run requested mid-run into one more pass instead of running twice at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = memoryStore([owed('a')]);
    let inFlight = 0;
    let maxInFlight = 0;
    const forward = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight--;
      return {};
    });
    const forwarder = createKbForwarder(store, forward);

    const first = forwarder.run();
    await vi.waitFor(() => expect(forward).toHaveBeenCalledTimes(1));
    const second = forwarder.run(); // arrives while 'a' is still in flight
    await second;
    release();
    await first;

    expect(maxInFlight).toBe(1);
    // The extra pass ran: one claim for 'a', one that came back empty, then the rerun's claim.
    expect(store.claimNext).toHaveBeenCalledTimes(3);
  });

  it('survives a database error and leaves the next run free to try again', async () => {
    const store = memoryStore([]);
    store.claimNext.mockRejectedValueOnce(new Error('connection terminated'));
    const forwarder = createKbForwarder(store, vi.fn(async () => ({})));

    await expect(forwarder.run()).resolves.toBeUndefined();
    store.claimNext.mockResolvedValueOnce(owed('later'));
    await forwarder.run();

    expect(store.markForwarded).toHaveBeenCalledWith('later');
  });
});
