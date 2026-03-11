import type { Context, Next } from 'hono';
import { verifyJwt, type JwtClaims } from '../lib/jwt.js';
import { config } from '../lib/config.js';
import { Errors } from '../lib/errors.js';
import { authService } from '../services/auth.service.js';

declare module 'hono' {
  interface ContextVariableMap {
    user: { id: string; email: string; name: string; authRole: string };
    jwtClaims: JwtClaims;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw Errors.unauthorized();
  }

  const token = header.slice(7);
  let claims: JwtClaims;
  try {
    claims = await verifyJwt(token, config.JWT_SECRET);
  } catch {
    throw Errors.unauthorized();
  }

  c.set('jwtClaims', claims);

  const user = await authService.getOrCreateUser(claims);
  c.set('user', {
    id: user.id,
    email: user.email,
    name: user.name ?? '',
    authRole: user.authRole,
  });

  await next();
}
