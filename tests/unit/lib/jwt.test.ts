import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyJwt } from '../../../src/lib/jwt.js';

const SECRET = 'test-secret-key-at-least-32-chars!!';

describe('verifyJwt', () => {
  it('verifies a valid token and returns claims', async () => {
    const token = await new SignJWT({ email: 'test@example.com', name: 'Test', role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-uuid-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));

    const claims = await verifyJwt(token, SECRET);
    expect(claims.sub).toBe('user-uuid-123');
    expect(claims.email).toBe('test@example.com');
    expect(claims.role).toBe('user');
  });

  it('throws on invalid token', async () => {
    await expect(verifyJwt('garbage', SECRET)).rejects.toThrow();
  });

  it('throws on expired token', async () => {
    const token = await new SignJWT({ email: 'test@example.com', name: 'Test', role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-uuid-123')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(SECRET));

    await expect(verifyJwt(token, SECRET)).rejects.toThrow();
  });
});
