import type { Context, Next } from 'hono';
import { Errors } from '../lib/errors.js';

export async function adminMiddleware(c: Context, next: Next) {
  const user = c.get('user');
  if (user.authRole !== 'admin') {
    throw Errors.forbidden('Admin access required');
  }
  await next();
}
