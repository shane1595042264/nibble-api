import { describe, it, expect, beforeEach } from 'vitest';
import { db, kbWake, loadSyncService, resetDb } from './sync-harness.js';

// 2026-11-17: a slow knowledge base used to fail new words inside POST /sync
// (inline forward, 10s timeout), so the client showed "Sync failed — 1 item
// will retry" and re-pushed until the KB answered in time. Now sync only saves
// the word and wakes src/jobs/kb-forward.ts; the KB is never on this path.

const syncService = await loadSyncService();

const USER = 'e95b4721-26ff-42c6-9ba9-599a8d0f8d26';
const NEW_WORD = '428125a0-4c2d-40bc-b7fb-6dac9249af25';
const KNOWN_WORD = '557a52d8-0916-465f-8421-32340149229f';
const LAST_SYNCED = '2026-11-17T20:52:00.000Z';

const emptyChanges = { books: [], chapters: [], sections: [], vocabulary: [], settings: null, exerciseProgress: [] };
const push = (changes: Partial<typeof emptyChanges>) =>
  syncService.sync(USER, { lastSyncedAt: LAST_SYNCED, changes: { ...emptyChanges, ...changes } as any });

const OUTBOX_KEYS = ['kbForwardedAt', 'kbForwardAttempts', 'kbNextAttemptAt', 'kbLastError'];

beforeEach(() => {
  resetDb();
  db.vocab.seed({
    id: KNOWN_WORD, userId: USER, word: 'synchronize', translation: 'old',
    kbForwardedAt: new Date('2026-10-29T18:54:13.000Z'), kbForwardAttempts: 0, kbNextAttemptAt: null, kbLastError: null,
    updatedAt: new Date('2026-10-29T18:54:12.761Z'),
  });
});

describe('syncService.sync — new vocabulary and the knowledge-base outbox', () => {
  it('saves a new word straight away and wakes the forwarder once, without failing it', async () => {
    const res = await push({
      vocabulary: [
        { id: NEW_WORD, word: 'kan136-ownbook-test', translation: 'x', updatedAt: '2026-11-17T20:53:58.310Z' },
      ] as any,
    });

    expect(res.failedEntities.vocabulary).toEqual([]);
    expect(db.vocab.create).toHaveBeenCalledTimes(1);
    expect(db.vocab.rows.get(NEW_WORD)).toMatchObject({ userId: USER, word: 'kan136-ownbook-test' });
    expect(kbWake).toHaveBeenCalledTimes(1);
  });

  it('wakes the forwarder once per sync however many words it saved', async () => {
    await push({
      vocabulary: [
        { id: NEW_WORD, word: 'a', updatedAt: '2026-11-17T20:53:58.310Z' },
        { id: '11111111-1111-4111-8111-111111111111', word: 'b', updatedAt: '2026-11-17T20:53:58.310Z' },
      ] as any,
    });

    expect(db.vocab.create).toHaveBeenCalledTimes(2);
    expect(kbWake).toHaveBeenCalledTimes(1);
  });

  it('does not wake the forwarder for an edit to a word the server already has', async () => {
    await push({
      vocabulary: [{ id: KNOWN_WORD, word: 'synchronize', translation: 'new', updatedAt: '2026-11-17T21:00:00.000Z' }] as any,
    });

    expect(db.vocab.update).toHaveBeenCalledTimes(1);
    expect(kbWake).not.toHaveBeenCalled();
  });

  it('ignores outbox fields a client sends on a new word, so no device can mark it forwarded', async () => {
    await push({
      vocabulary: [{
        id: NEW_WORD, word: 'sneaky', updatedAt: '2026-11-17T20:53:58.310Z',
        kbForwardedAt: '2026-01-01T00:00:00.000Z', kbForwardAttempts: 99, kbNextAttemptAt: '2099-01-01T00:00:00.000Z', kbLastError: 'x',
      }] as any,
    });

    const created = db.vocab.create.mock.calls[0][0];
    for (const key of OUTBOX_KEYS) expect(created).not.toHaveProperty(key);
  });

  it('ignores outbox fields a client sends on an edit', async () => {
    await push({
      vocabulary: [{
        id: KNOWN_WORD, word: 'synchronize', updatedAt: '2026-11-17T21:00:00.000Z',
        kbForwardedAt: null, kbForwardAttempts: 0,
      }] as any,
    });

    const [, data] = db.vocab.update.mock.calls[0];
    for (const key of OUTBOX_KEYS) expect(data).not.toHaveProperty(key);
    expect(db.vocab.rows.get(KNOWN_WORD)!.kbForwardedAt).toEqual(new Date('2026-10-29T18:54:13.000Z'));
  });

  it('never sends the outbox fields to a client', async () => {
    const res = await syncService.sync(USER, { lastSyncedAt: '2026-01-01T00:00:00.000Z', changes: emptyChanges as any });

    const sent = res.serverChanges.vocabulary.find((v) => v.id === KNOWN_WORD);
    expect(sent).toBeDefined();
    for (const key of OUTBOX_KEYS) expect(sent).not.toHaveProperty(key);
  });
});
