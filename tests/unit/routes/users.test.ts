import { describe, it, expect } from 'vitest';
import {
  updateProfileSchema,
  validateAvatarUrlForUser,
  expectedOwnAvatarUrl,
} from '../../../src/routes/users.js';

const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';

describe('updateProfileSchema', () => {
  it('accepts empty body', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(true);
  });

  it('accepts name + emoji avatar', () => {
    const r = updateProfileSchema.safeParse({ name: 'Alice', avatarUrl: '🎨' });
    expect(r.success).toBe(true);
  });

  it('accepts empty-string avatarUrl (clear avatar)', () => {
    expect(updateProfileSchema.safeParse({ avatarUrl: '' }).success).toBe(true);
  });

  it('rejects avatarUrl over 500 chars', () => {
    const r = updateProfileSchema.safeParse({ avatarUrl: 'a'.repeat(501) });
    expect(r.success).toBe(false);
  });

  it('rejects name over 100 chars', () => {
    const r = updateProfileSchema.safeParse({ name: 'a'.repeat(101) });
    expect(r.success).toBe(false);
  });
});

describe('validateAvatarUrlForUser', () => {
  it('accepts emoji', () => {
    expect(validateAvatarUrlForUser('🎨', userId)).toBeNull();
  });

  it('accepts http(s) avatar (Google OAuth)', () => {
    expect(
      validateAvatarUrlForUser('https://lh3.googleusercontent.com/a/AAA', userId),
    ).toBeNull();
  });

  it('accepts empty string (clear avatar)', () => {
    expect(validateAvatarUrlForUser('', userId)).toBeNull();
  });

  it('accepts the user own r2 avatar key', () => {
    expect(validateAvatarUrlForUser(expectedOwnAvatarUrl(userId), userId)).toBeNull();
  });

  it('rejects another user r2 avatar key', () => {
    expect(
      validateAvatarUrlForUser(expectedOwnAvatarUrl(otherUserId), userId),
    ).toBe('Invalid avatarUrl');
  });

  it('rejects r2:pdfs key (the KAN-196 exploit)', () => {
    expect(
      validateAvatarUrlForUser('r2:pdfs/deadbeef.pdf', userId),
    ).toBe('Invalid avatarUrl');
  });

  it('rejects r2:nibs key', () => {
    expect(
      validateAvatarUrlForUser('r2:nibs/deadbeef.nib.json', userId),
    ).toBe('Invalid avatarUrl');
  });

  it('rejects r2:epubs key', () => {
    expect(
      validateAvatarUrlForUser('r2:epubs/deadbeef.epub', userId),
    ).toBe('Invalid avatarUrl');
  });

  it('rejects oversize avatarUrl', () => {
    expect(
      validateAvatarUrlForUser('a'.repeat(501), userId),
    ).toBe('avatarUrl too long');
  });

  it('expectedOwnAvatarUrl always shapes the avatars/<id>.webp key', () => {
    expect(expectedOwnAvatarUrl(userId)).toBe(`r2:avatars/${userId}.webp`);
  });
});

