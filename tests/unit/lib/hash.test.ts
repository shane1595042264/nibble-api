import { describe, it, expect } from 'vitest';
import { sha256 } from '../../../src/lib/hash.js';

describe('sha256', () => {
  it('returns a hex string', () => {
    const hash = sha256(Buffer.from('hello'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns consistent hashes', () => {
    const a = sha256(Buffer.from('test'));
    const b = sha256(Buffer.from('test'));
    expect(a).toBe(b);
  });

  it('returns different hashes for different inputs', () => {
    const a = sha256(Buffer.from('hello'));
    const b = sha256(Buffer.from('world'));
    expect(a).not.toBe(b);
  });
});
