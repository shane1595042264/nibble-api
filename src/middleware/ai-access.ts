import type { Context, Next } from 'hono';
import { hasFreeAiAccess } from '../lib/billing-access.js';
import { Errors } from '../lib/errors.js';

export async function aiAccessMiddleware(c: Context, next: Next) {
  const user = c.get('user');
  if (hasFreeAiAccess(user)) {
    await next();
    return;
  }
  throw Errors.paymentRequired();
}
