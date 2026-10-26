import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/config.js', () => ({
  config: { FREE_AI_EMAILS: 'free@example.com' },
}));

import { aiAccessMiddleware } from '../../../src/middleware/ai-access.js';
import { AppError } from '../../../src/lib/errors.js';

function makeCtx(user: { email: string; authRole: string }) {
  return { get: (k: string) => (k === 'user' ? user : undefined) } as any;
}

// KAN-367: the gate used to throw paymentRequired(), whose 'Processing job not yet
// paid' copy the reader printed verbatim to every user without AI access.
describe('aiAccessMiddleware', () => {
  it('lets an admin through', async () => {
    const next = vi.fn(async () => {});
    await aiAccessMiddleware(makeCtx({ email: 'a@example.com', authRole: 'admin' }), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('lets a FREE_AI_EMAILS user through', async () => {
    const next = vi.fn(async () => {});
    await aiAccessMiddleware(makeCtx({ email: 'Free@Example.com', authRole: 'user' }), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('refuses anyone else with a 402 AI_ACCESS_REQUIRED, not the billing copy', async () => {
    const next = vi.fn(async () => {});
    const err = await aiAccessMiddleware(makeCtx({ email: 'u@example.com', authRole: 'user' }), next).catch((e) => e);
    expect(next).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(402);
    expect(err.code).toBe('AI_ACCESS_REQUIRED');
    expect(err.message).not.toMatch(/processing job/i);
  });
});
