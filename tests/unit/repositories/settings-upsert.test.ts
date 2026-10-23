import { describe, it, expect, beforeEach, vi } from 'vitest';

// POST /api/sync hands the client's settings blob straight to upsert. A body
// userId used to be spread AFTER the authenticated one, so ON CONFLICT (user_id)
// matched another user's row and overwrote their settings (KAN-363).
const calls = vi.hoisted(() => ({ values: [] as any[], set: [] as any[] }));
vi.mock('../../../src/db/index.js', () => {
  const chain: any = {
    values: (v: unknown) => { calls.values.push(v); return chain; },
    onConflictDoUpdate: (o: { set: unknown }) => { calls.set.push(o.set); return chain; },
    onConflictDoNothing: () => chain,
    returning: async () => [{}],
  };
  return { db: { insert: () => chain } };
});

const { settingsRepository } = await import('../../../src/repositories/settings.repository.js');
const { syncPayloadSchema } = await import('../../../src/routes/sync.js');

const CALLER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '99999999-9999-4999-8999-999999999999';
const ROW_ID = '88888888-8888-4888-8888-888888888888';

beforeEach(() => {
  calls.values.length = 0;
  calls.set.length = 0;
});

describe('settingsRepository.upsert', () => {
  it("writes only the caller's row when the payload carries userId and id", async () => {
    await settingsRepository.upsert(CALLER, {
      userId: VICTIM, id: ROW_ID, updatedAt: '2000-01-01', targetLanguage: 'zz-probe',
    } as any);

    expect(calls.values).toEqual([{ userId: CALLER, targetLanguage: 'zz-probe' }]);
    expect(calls.set).toHaveLength(1);
    expect(calls.set[0]).toEqual({ targetLanguage: 'zz-probe', updatedAt: expect.any(Date) });
  });

  it('treats a payload with only non-settings keys as an empty write', async () => {
    await settingsRepository.upsert(CALLER, { userId: VICTIM, id: ROW_ID } as any);

    expect(calls.values).toEqual([{ userId: CALLER }]);
    expect(calls.set).toEqual([]);
  });

  it('still writes every settings column', async () => {
    const all = {
      autoReadThresholdSeconds: 9,
      defaultViewMode: 'text',
      readingMode: 'page',
      trackingMode: 'manual',
      targetLanguage: 'fr',
      keymapOverrides: { 'prev-page': 'Shift+d' },
    };
    await settingsRepository.upsert(CALLER, all);

    expect(calls.values).toEqual([{ ...all, userId: CALLER }]);
    expect(calls.set[0]).toEqual({ ...all, updatedAt: expect.any(Date) });
  });
});

describe('syncPayloadSchema settings', () => {
  const parse = (settings: Record<string, unknown>) =>
    syncPayloadSchema.parse({ lastSyncedAt: '2026-01-01T00:00:00.000Z', changes: { settings } }).changes.settings;

  it('strips userId and id', () => {
    expect(parse({ userId: VICTIM, id: ROW_ID, targetLanguage: 'zz-probe' })).toEqual({ targetLanguage: 'zz-probe' });
  });

  it('still drops an invalid enum instead of rejecting the push', () => {
    expect(parse({ readingMode: 'sideways', targetLanguage: 'fr' })).toEqual({ readingMode: undefined, targetLanguage: 'fr' });
  });
});
