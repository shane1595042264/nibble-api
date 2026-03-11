import type { Context, Next } from 'hono';
import { verifyJwt, type JwtClaims } from '../lib/jwt.js';
import { config } from '../lib/config.js';
import { Errors } from '../lib/errors.js';

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

  // User upsert will be added in Task 3 when we have the DB layer.
  // For now, set a minimal user object from JWT claims.
  c.set('user', {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    authRole: claims.role,
  });

  await next();
}
