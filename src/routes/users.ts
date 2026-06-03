import { Hono } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/user.repository.js';
import { storageService } from '../services/storage.service.js';
import { AppError } from '../lib/errors.js';
import { checkFailureLockout, recordFailure } from '../middleware/rate-limit.js';

export const userRoutes = new Hono();

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const R2_AVATAR_PREFIX = 'r2:';
const R2_AVATAR_KEY_PREFIX = 'avatars/';
const AVATAR_URL_MAX = 500;
const PASSWORD_BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 6;
const PASSWORD_MAX_FAILURES = 5;
const PASSWORD_FAILURE_WINDOW_MS = 60 * 60 * 1000;

/** Expected R2 avatar value the client may submit for itself. */
export function expectedOwnAvatarUrl(userId: string): string {
  return `${R2_AVATAR_PREFIX}${R2_AVATAR_KEY_PREFIX}${userId}.webp`;
}

/**
 * Reject an avatarUrl that:
 *  - exceeds the max length, or
 *  - is r2:-prefixed but does not equal the requesting user's own avatar key.
 * Returns null when valid; an error message when not.
 */
export function validateAvatarUrlForUser(avatarUrl: string, userId: string): string | null {
  if (avatarUrl.length > AVATAR_URL_MAX) return 'avatarUrl too long';
  if (avatarUrl.startsWith(R2_AVATAR_PREFIX) && avatarUrl !== expectedOwnAvatarUrl(userId)) {
    return 'Invalid avatarUrl';
  }
  return null;
}

/**
 * If avatarUrl is an R2 key, resolve it to a fresh presigned URL.
 * Defense in depth: only sign keys under avatars/; any other prefix returns null,
 * even if it slipped past PUT /me validation (stale rows, future code changes).
 */
async function resolveAvatarUrl(avatarUrl: string | null): Promise<string | null> {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith(R2_AVATAR_PREFIX)) {
    const r2Key = avatarUrl.slice(R2_AVATAR_PREFIX.length);
    if (!r2Key.startsWith(R2_AVATAR_KEY_PREFIX)) return null;
    return storageService.getAvatarUrl(r2Key);
  }
  return avatarUrl;
}

function userJson(user: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  authRole: string;
  passwordHash?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    authRole: user.authRole,
    hasPassword: !!user.passwordHash,
  };
}

// ─── GET /me ─────────────────────────────────────────────────────
userRoutes.get('/me', async (c) => {
  const user = c.get('user');
  const full = await userRepository.findById(user.id);
  if (!full) throw new AppError('NOT_FOUND', 'User not found', 404);

  const resolved = await resolveAvatarUrl(full.avatarUrl);
  return c.json(userJson({ ...full, avatarUrl: resolved }));
});

// ─── PUT /me ─────────────────────────────────────────────────────
export const updateProfileSchema = z.object({
  name: z.string().max(100).optional(),
  avatarUrl: z.string().max(AVATAR_URL_MAX).optional(),
});

userRoutes.put('/me', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }

  if (parsed.data.avatarUrl !== undefined) {
    const err = validateAvatarUrlForUser(parsed.data.avatarUrl, user.id);
    if (err) throw new AppError('VALIDATION_ERROR', err, 400);
  }

  const data: Record<string, string> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.avatarUrl !== undefined) data.avatarUrl = parsed.data.avatarUrl;

  if (Object.keys(data).length === 0) {
    const full = await userRepository.findById(user.id);
    if (!full) throw new AppError('NOT_FOUND', 'User not found', 404);
    const resolved = await resolveAvatarUrl(full.avatarUrl);
    return c.json(userJson({ ...full, avatarUrl: resolved }));
  }

  const updated = await userRepository.update(user.id, data);
  if (!updated) throw new AppError('NOT_FOUND', 'User not found', 404);

  const resolved = await resolveAvatarUrl(updated.avatarUrl);
  return c.json(userJson({ ...updated, avatarUrl: resolved }));
});

// ─── POST /me/password ───────────────────────────────────────────
// Set a password for the first time (OAuth-only user) or change an existing one.
// currentPassword is required iff the user already has a password.
const passwordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH),
});

userRoutes.post('/me/password', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = passwordSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }

  const full = await userRepository.findById(user.id);
  if (!full) throw new AppError('NOT_FOUND', 'User not found', 404);

  if (full.passwordHash) {
    // Rate limit only applies to the change-password branch, and only counts failed
    // bcrypt.compare attempts — not schema-validation errors. Initial-password set
    // (OAuth users with no password yet) is not rate-limited at all.
    const lockoutKey = `password:${user.id}`;
    const lock = checkFailureLockout(lockoutKey, PASSWORD_MAX_FAILURES, PASSWORD_FAILURE_WINDOW_MS);
    if (lock.locked) {
      const retryAfter = Math.max(1, Math.ceil(lock.retryAfterMs / 1000));
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests', status: 429 } },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }

    if (!parsed.data.currentPassword) {
      throw new AppError('VALIDATION_ERROR', 'Current password is required', 400);
    }
    const ok = await bcrypt.compare(parsed.data.currentPassword, full.passwordHash);
    if (!ok) {
      recordFailure(lockoutKey, PASSWORD_FAILURE_WINDOW_MS);
      throw new AppError('VALIDATION_ERROR', 'Current password is incorrect', 400);
    }
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, PASSWORD_BCRYPT_ROUNDS);
  await userRepository.update(user.id, { passwordHash });
  return c.json({ success: true });
});

// ─── POST /me/avatar ─────────────────────────────────────────────
userRoutes.post('/me/avatar', async (c) => {
  const user = c.get('user');
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    throw new AppError('VALIDATION_ERROR', 'No file provided', 400);
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new AppError('VALIDATION_ERROR', 'File must be JPEG, PNG, or WebP', 400);
  }

  if (file.size > MAX_AVATAR_SIZE) {
    throw new AppError('VALIDATION_ERROR', 'File must be under 2 MB', 400);
  }

  // uploadAvatar writes the deterministic key avatars/{userId}.webp, so PutObject
  // overwrites any prior object atomically. Doing a pre-upload delete would only
  // open a window where the DB still references an R2 key that no longer exists
  // if sharp/PutObject then throws.
  const buffer = Buffer.from(await file.arrayBuffer());
  const r2Key = await storageService.uploadAvatar(user.id, buffer, file.type);

  // Store the R2 key with prefix so GET /me can generate fresh presigned URLs
  await userRepository.update(user.id, { avatarUrl: `${R2_AVATAR_PREFIX}${r2Key}` });

  // Return both the R2 key (for session storage) and a fresh presigned URL (for immediate display)
  const r2Value = `${R2_AVATAR_PREFIX}${r2Key}`;
  const avatarUrl = await storageService.getAvatarUrl(r2Key);
  return c.json({ avatarUrl, r2Key: r2Value });
});
