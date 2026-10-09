import { describe, it, expect } from 'vitest';
import { planStuckJobActions, type StuckJobAction } from '../../../src/jobs/queue.js';

const now = new Date('2026-06-14T13:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);
const row = (
  id: string,
  createdMinutesAgo: number,
  over: Partial<{ status: string; processingCostCents: number | null; stripePaymentIntentId: string | null }> = {},
) => ({
  id,
  createdAt: minutesAgo(createdMinutesAgo),
  status: 'processing',
  processingCostCents: null,
  stripePaymentIntentId: null,
  ...over,
});

describe('planStuckJobActions', () => {
  it('sub-cap stuck job is queued for one more retry', () => {
    const actions = planStuckJobActions(
      [{ id: 'a', createdAt: minutesAgo(20), status: 'processing', processingCostCents: 500, stripePaymentIntentId: 'pi_1' }],
      now,
    );
    expect(actions).toEqual<StuckJobAction[]>([{ id: 'a', action: 'retry' }]);
  });

  it('over-cap paid stuck job is auto-failed with stripePaymentIntentId surfaced for refund', () => {
    const actions = planStuckJobActions(
      [{ id: 'b', createdAt: minutesAgo(120), status: 'processing', processingCostCents: 500, stripePaymentIntentId: 'pi_2' }],
      now,
    );
    expect(actions).toEqual<StuckJobAction[]>([
      { id: 'b', action: 'auto-fail', stripePaymentIntentId: 'pi_2' },
    ]);
  });

  it('over-cap non-paid stuck job is auto-failed with null PI (caller skips refund)', () => {
    const actions = planStuckJobActions(
      [{ id: 'c', createdAt: minutesAgo(120), status: 'processing', processingCostCents: null, stripePaymentIntentId: null }],
      now,
    );
    expect(actions).toEqual<StuckJobAction[]>([
      { id: 'c', action: 'auto-fail', stripePaymentIntentId: null },
    ]);
  });

  it('boundary at exactly the one-hour mark is auto-failed (cap is strict >)', () => {
    const actions = planStuckJobActions(
      [{ id: 'd', createdAt: minutesAgo(60), status: 'processing', processingCostCents: 500, stripePaymentIntentId: 'pi_3' }],
      now,
    );
    expect(actions[0].action).toBe('auto-fail');
  });

  it('classifies a mixed batch in order', () => {
    const actions = planStuckJobActions(
      [
        { id: 'r', createdAt: minutesAgo(15), status: 'processing', processingCostCents: 500, stripePaymentIntentId: 'pi_r' },
        { id: 'f', createdAt: minutesAgo(75), status: 'processing', processingCostCents: 500, stripePaymentIntentId: 'pi_f' },
        { id: 'u', createdAt: minutesAgo(180), status: 'processing', processingCostCents: null, stripePaymentIntentId: null },
      ],
      now,
    );
    expect(actions.map((a) => a.action)).toEqual(['retry', 'auto-fail', 'auto-fail']);
    const failedAction = actions[1];
    if (failedAction.action !== 'auto-fail') throw new Error('expected auto-fail');
    expect(failedAction.stripePaymentIntentId).toBe('pi_f');
  });

  it('returns empty when there are no stuck rows', () => {
    expect(planStuckJobActions([], now)).toEqual([]);
  });

  it('respects custom retryWindowMs (e.g. tighter cap for tests)', () => {
    const actions = planStuckJobActions(
      [{ id: 'x', createdAt: minutesAgo(20), status: 'processing', processingCostCents: 500, stripePaymentIntentId: 'pi_x' }],
      now,
      10 * 60 * 1000,
    );
    expect(actions[0].action).toBe('auto-fail');
  });

  // KAN-340: the upload and /retry paths never set paid or a cost. These are the
  // jobs a redeploy actually orphans.
  it('unpaid upload-path job stuck in processing is retried', () => {
    expect(planStuckJobActions([row('up', 20)], now)).toEqual<StuckJobAction[]>([
      { id: 'up', action: 'retry' },
    ]);
  });

  it('upload-path job still pending (died before its first progress write) is recovered', () => {
    const actions = planStuckJobActions(
      [row('young', 20, { status: 'pending' }), row('old', 120, { status: 'pending' })],
      now,
    );
    expect(actions).toEqual<StuckJobAction[]>([
      { id: 'young', action: 'retry' },
      { id: 'old', action: 'auto-fail', stripePaymentIntentId: null },
    ]);
  });

  it('pending Stripe job awaiting payment is left alone, however old', () => {
    const actions = planStuckJobActions(
      [
        row('await-young', 20, { status: 'pending', processingCostCents: 500, stripePaymentIntentId: 'pi_w' }),
        row('await-old', 300, { status: 'pending', processingCostCents: 500, stripePaymentIntentId: 'pi_w2' }),
      ],
      now,
    );
    expect(actions).toEqual([]);
  });

  it('pending free /processing/start job (cost 0) is left to the worker poll', () => {
    expect(planStuckJobActions([row('free', 20, { status: 'pending', processingCostCents: 0 })], now)).toEqual([]);
  });

  it('skips a job whose pipeline is still running in this process (slow stage, not dead)', () => {
    const actions = planStuckJobActions(
      [row('alive', 20), row('alive-old', 120), row('dead', 20)],
      now,
      undefined,
      new Set(['alive', 'alive-old']),
    );
    expect(actions).toEqual<StuckJobAction[]>([{ id: 'dead', action: 'retry' }]);
  });
});
