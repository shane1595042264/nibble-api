import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks (hoisted so the factories can reference the shared fns) ───────────
const { constructEventMock } = vi.hoisted(() => ({ constructEventMock: vi.fn() }));

vi.mock('stripe', () => {
  class Stripe {
    webhooks = { constructEvent: constructEventMock };
    static errors = { StripeInvalidRequestError: class StripeInvalidRequestError extends Error {} };
  }
  return { default: Stripe };
});

vi.mock('../../../src/lib/config.js', () => ({
  config: {
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    PROCESSING_PRICE_PER_PAGE_CENTS: 10,
  },
}));

// A tiny stateful fake of the webhook_events table backing the chainable db API
// the service uses: select→from→where→limit, insert→values→onConflictDoNothing→
// returning, and update→set→where.
const dbState: { row: { status: string; createdAt: Date; error: string | null } | null } = { row: null };
vi.mock('../../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (dbState.row ? [dbState.row] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (dbState.row) return []; // unique conflict — concurrent insert won
            dbState.row = { status: v.status, createdAt: new Date(), error: null };
            return [dbState.row];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: async () => {
          if (dbState.row) Object.assign(dbState.row, patch);
        },
      }),
    }),
  },
}));

const repo = vi.hoisted(() => ({
  updateJobStatus: vi.fn(),
  findChargeByPaymentIntentId: vi.fn(),
  updateChargeStatus: vi.fn(),
}));
vi.mock('../../../src/repositories/billing.repository.js', () => ({ billingRepository: repo }));

import {
  billingService,
  classifyWebhookEvent,
  WEBHOOK_PROCESSING_STALE_MS,
} from '../../../src/services/billing.service.js';

// ─── Pure dedup-decision logic ──────────────────────────────────────────────
describe('classifyWebhookEvent', () => {
  const now = 1_000_000_000_000;

  it('processes when there is no existing row', () => {
    expect(classifyWebhookEvent(undefined, now)).toBe('process');
  });

  it('skips an already-processed event (true duplicate)', () => {
    expect(classifyWebhookEvent({ status: 'processed', createdAt: new Date(now) }, now)).toBe('skip');
  });

  it('reprocesses a previously-failed event', () => {
    expect(classifyWebhookEvent({ status: 'failed', createdAt: new Date(now) }, now)).toBe('process');
  });

  it('skips a recent processing row (likely a concurrent in-flight delivery)', () => {
    const createdAt = new Date(now - (WEBHOOK_PROCESSING_STALE_MS - 1_000));
    expect(classifyWebhookEvent({ status: 'processing', createdAt }, now)).toBe('skip');
  });

  it('reprocesses a stale processing row (handler crashed mid-flight)', () => {
    const createdAt = new Date(now - (WEBHOOK_PROCESSING_STALE_MS + 1_000));
    expect(classifyWebhookEvent({ status: 'processing', createdAt }, now)).toBe('process');
  });

  it('reprocesses an unknown status defensively', () => {
    expect(classifyWebhookEvent({ status: 'weird', createdAt: new Date(now) }, now)).toBe('process');
  });

  it('accepts a string createdAt (as Postgres/JSON may hand back)', () => {
    const iso = new Date(now - (WEBHOOK_PROCESSING_STALE_MS + 1_000)).toISOString();
    expect(classifyWebhookEvent({ status: 'processing', createdAt: iso }, now)).toBe('process');
  });
});

// ─── End-to-end handleWebhook flow ──────────────────────────────────────────
describe('billingService.handleWebhook — reprocess after transient failure', () => {
  const event = {
    id: 'evt_test_1',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_test_1', metadata: { jobId: 'job_1' } } },
  };

  beforeEach(() => {
    dbState.row = null;
    repo.updateJobStatus.mockReset();
    repo.findChargeByPaymentIntentId.mockReset();
    repo.updateChargeStatus.mockReset();
    constructEventMock.mockReset();
    constructEventMock.mockReturnValue(event);
  });

  it('does not permanently drop a paid job when the first delivery throws', async () => {
    // First delivery: updateJobStatus throws a transient error.
    repo.updateJobStatus.mockRejectedValueOnce(new Error('transient DB error'));

    await expect(billingService.handleWebhook('payload', 'sig')).rejects.toThrow('transient DB error');
    // Row was recorded then flagged failed (not left as a silent duplicate skip).
    expect(dbState.row?.status).toBe('failed');

    // Second delivery (Stripe retry / dashboard Resend): now succeeds. The fix
    // means the 'failed' row is REPROCESSED, not skipped.
    repo.updateJobStatus.mockResolvedValueOnce({ id: 'job_1', paid: true });
    repo.findChargeByPaymentIntentId.mockResolvedValueOnce({ id: 'charge_1' });
    repo.updateChargeStatus.mockResolvedValueOnce({ id: 'charge_1', status: 'paid' });

    await billingService.handleWebhook('payload', 'sig');

    expect(repo.updateJobStatus).toHaveBeenLastCalledWith('job_1', { paid: true });
    expect(repo.updateChargeStatus).toHaveBeenCalledWith('charge_1', { status: 'paid' });
    expect(dbState.row?.status).toBe('processed');
  });

  it('short-circuits an already-processed event without re-running side effects', async () => {
    // Simulate a row already marked processed.
    dbState.row = { status: 'processed', createdAt: new Date(), error: null };

    await billingService.handleWebhook('payload', 'sig');

    expect(repo.updateJobStatus).not.toHaveBeenCalled();
    expect(repo.updateChargeStatus).not.toHaveBeenCalled();
    expect(dbState.row.status).toBe('processed');
  });

  it('reprocesses a stale processing row (crash recovery)', async () => {
    dbState.row = {
      status: 'processing',
      createdAt: new Date(Date.now() - (WEBHOOK_PROCESSING_STALE_MS + 5_000)),
      error: null,
    };
    repo.updateJobStatus.mockResolvedValueOnce({ id: 'job_1', paid: true });
    repo.findChargeByPaymentIntentId.mockResolvedValueOnce({ id: 'charge_1' });
    repo.updateChargeStatus.mockResolvedValueOnce({ id: 'charge_1', status: 'paid' });

    await billingService.handleWebhook('payload', 'sig');

    expect(repo.updateJobStatus).toHaveBeenCalledWith('job_1', { paid: true });
    expect(dbState.row.status).toBe('processed');
  });
});
