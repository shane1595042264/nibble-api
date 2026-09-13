import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks (hoisted so the factories can reference the shared fns) ───────────
const { constructEventMock, refundsCreateMock } = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  refundsCreateMock: vi.fn(),
}));

vi.mock('stripe', () => {
  class Stripe {
    webhooks = { constructEvent: constructEventMock };
    refunds = { create: refundsCreateMock };
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
  findJobById: vi.fn(),
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

// ─── Failure refunds (KAN-303) ──────────────────────────────────────────────
describe('billingService.refund — idempotency', () => {
  beforeEach(() => {
    refundsCreateMock.mockReset();
    repo.findChargeByPaymentIntentId.mockReset();
    repo.updateChargeStatus.mockReset();
    refundsCreateMock.mockResolvedValue({ id: 're_1' });
    repo.updateChargeStatus.mockResolvedValue({ id: 'charge_1', status: 'refunded' });
  });

  it('refunds a paid charge and flips the charge row to refunded', async () => {
    repo.findChargeByPaymentIntentId.mockResolvedValue({ id: 'charge_1', status: 'paid' });

    await billingService.refund('pi_1');

    expect(refundsCreateMock).toHaveBeenCalledTimes(1);
    expect(refundsCreateMock).toHaveBeenCalledWith(
      { payment_intent: 'pi_1' },
      { idempotencyKey: 'refund:pi_1' },
    );
    expect(repo.updateChargeStatus).toHaveBeenCalledWith('charge_1', { status: 'refunded' });
  });

  it('does not hit Stripe a second time once the charge is already refunded', async () => {
    repo.findChargeByPaymentIntentId.mockResolvedValue({ id: 'charge_1', status: 'refunded' });

    await billingService.refund('pi_1');

    expect(refundsCreateMock).not.toHaveBeenCalled();
    expect(repo.updateChargeStatus).not.toHaveBeenCalled();
  });

  it('still refunds when no charge row exists, guarded only by the idempotency key', async () => {
    repo.findChargeByPaymentIntentId.mockResolvedValue(null);

    await billingService.refund('pi_orphan');

    expect(refundsCreateMock).toHaveBeenCalledWith(
      { payment_intent: 'pi_orphan' },
      { idempotencyKey: 'refund:pi_orphan' },
    );
    expect(repo.updateChargeStatus).not.toHaveBeenCalled();
  });
});

describe('billingService.refundFailedJob', () => {
  beforeEach(() => {
    refundsCreateMock.mockReset();
    repo.findJobById.mockReset();
    repo.findChargeByPaymentIntentId.mockReset();
    repo.updateChargeStatus.mockReset();
    refundsCreateMock.mockResolvedValue({ id: 're_1' });
    repo.updateChargeStatus.mockResolvedValue({ id: 'charge_1', status: 'refunded' });
  });

  it('refunds exactly once with the payment intent on the job row', async () => {
    repo.findJobById.mockResolvedValue({ id: 'job_1', stripePaymentIntentId: 'pi_1' });
    repo.findChargeByPaymentIntentId.mockResolvedValue({ id: 'charge_1', status: 'paid' });

    await expect(billingService.refundFailedJob('job_1')).resolves.toBe('refunded');

    expect(refundsCreateMock).toHaveBeenCalledTimes(1);
    expect(refundsCreateMock).toHaveBeenCalledWith(
      { payment_intent: 'pi_1' },
      { idempotencyKey: 'refund:pi_1' },
    );
  });

  it('attempts only one refund per payment intent when the same job fails twice', async () => {
    repo.findJobById.mockResolvedValue({ id: 'job_1', stripePaymentIntentId: 'pi_1' });
    // First failure: charge is still 'paid'. Second failure: the row the first
    // refund wrote back, i.e. 'refunded'.
    repo.findChargeByPaymentIntentId
      .mockResolvedValueOnce({ id: 'charge_1', status: 'paid' })
      .mockResolvedValueOnce({ id: 'charge_1', status: 'refunded' });

    await billingService.refundFailedJob('job_1');
    await billingService.refundFailedJob('job_1');

    expect(refundsCreateMock).toHaveBeenCalledTimes(1);
  });

  it('takes no refund action for a free job and does not throw', async () => {
    repo.findJobById.mockResolvedValue({ id: 'job_free', stripePaymentIntentId: null });

    await expect(billingService.refundFailedJob('job_free')).resolves.toBe('no-charge');

    expect(refundsCreateMock).not.toHaveBeenCalled();
    expect(repo.updateChargeStatus).not.toHaveBeenCalled();
  });

  it('swallows a Stripe outage so caller error handling is never derailed', async () => {
    repo.findJobById.mockResolvedValue({ id: 'job_1', stripePaymentIntentId: 'pi_1' });
    repo.findChargeByPaymentIntentId.mockResolvedValue({ id: 'charge_1', status: 'paid' });
    refundsCreateMock.mockRejectedValue(new Error('stripe is down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reports the failure to the caller (which writes it to the job's log)
    // instead of throwing into the pipeline's catch block.
    await expect(billingService.refundFailedJob('job_1')).resolves.toBe('refund-failed');

    // The owed refund is loudly recorded rather than silently dropped.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL: refund failed for job job_1'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
