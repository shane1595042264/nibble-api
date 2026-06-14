import { describe, it, expect } from 'vitest';
import { planStuckJobActions, type StuckJobAction } from '../../../src/jobs/queue.js';

const now = new Date('2026-06-14T13:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);

describe('planStuckJobActions', () => {
  it('sub-cap stuck job is queued for one more retry', () => {
    const actions = planStuckJobActions(
      [{ id: 'a', createdAt: minutesAgo(20), stripePaymentIntentId: 'pi_1' }],
      now,
    );
    expect(actions).toEqual<StuckJobAction[]>([{ id: 'a', action: 'retry' }]);
  });

  it('over-cap paid stuck job is auto-failed with stripePaymentIntentId surfaced for refund', () => {
    const actions = planStuckJobActions(
      [{ id: 'b', createdAt: minutesAgo(120), stripePaymentIntentId: 'pi_2' }],
      now,
    );
    expect(actions).toEqual<StuckJobAction[]>([
      { id: 'b', action: 'auto-fail', stripePaymentIntentId: 'pi_2' },
    ]);
  });

  it('over-cap non-paid stuck job is auto-failed with null PI (caller skips refund)', () => {
    const actions = planStuckJobActions(
      [{ id: 'c', createdAt: minutesAgo(120), stripePaymentIntentId: null }],
      now,
    );
    expect(actions).toEqual<StuckJobAction[]>([
      { id: 'c', action: 'auto-fail', stripePaymentIntentId: null },
    ]);
  });

  it('boundary at exactly the one-hour mark is auto-failed (cap is strict >)', () => {
    const actions = planStuckJobActions(
      [{ id: 'd', createdAt: minutesAgo(60), stripePaymentIntentId: 'pi_3' }],
      now,
    );
    expect(actions[0].action).toBe('auto-fail');
  });

  it('classifies a mixed batch in order', () => {
    const actions = planStuckJobActions(
      [
        { id: 'r', createdAt: minutesAgo(15), stripePaymentIntentId: 'pi_r' },
        { id: 'f', createdAt: minutesAgo(75), stripePaymentIntentId: 'pi_f' },
        { id: 'u', createdAt: minutesAgo(180), stripePaymentIntentId: null },
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
      [{ id: 'x', createdAt: minutesAgo(20), stripePaymentIntentId: 'pi_x' }],
      now,
      10 * 60 * 1000,
    );
    expect(actions[0].action).toBe('auto-fail');
  });
});
