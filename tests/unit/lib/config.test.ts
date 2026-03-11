import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws if DATABASE_URL is missing', async () => {
    vi.stubEnv('DATABASE_URL', '');
    await expect(import('../../../src/lib/config.js')).rejects.toThrow();
    vi.unstubAllEnvs();
  });

  it('throws if JWT_SECRET is missing', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/test');
    vi.stubEnv('JWT_SECRET', '');
    await expect(import('../../../src/lib/config.js')).rejects.toThrow();
    vi.unstubAllEnvs();
  });
});
