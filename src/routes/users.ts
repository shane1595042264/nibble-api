import { Hono } from 'hono';
import { z } from 'zod';
import { userRepository } from '../repositories/user.repository.js';
import { storageService } from '../services/storage.service.js';
import { AppError } from '../lib/errors.js';

export const userRoutes = new Hono();

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const R2_AVATAR_PREFIX = 'r2:';

/** If avatarUrl is an R2 key, resolve it to a fresh presigned URL. */
async function resolveAvatarUrl(avatarUrl: string | null): Promise<string | null> {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith(R2_AVATAR_PREFIX)) {
    const r2Key = avatarUrl.slice(R2_AVATAR_PREFIX.length);
    return storageService.getAvatarUrl(r2Key);
  }
  return avatarUrl;
}

function userJson(user: { id: string; email: string; name: string | null; avatarUrl: string | null; authRole: string }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    authRole: user.authRole,
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
const updateProfileSchema = z.object({
  name: z.string().max(100).optional(),
  avatarUrl: z.string().optional(),
});

userRoutes.put('/me', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
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

  const buffer = Buffer.from(await file.arrayBuffer());
  const r2Key = await storageService.uploadAvatar(user.id, buffer, file.type);

  // Store the R2 key with prefix so GET /me can generate fresh presigned URLs
  await userRepository.update(user.id, { avatarUrl: `${R2_AVATAR_PREFIX}${r2Key}` });

  // Return both the R2 key (for session storage) and a fresh presigned URL (for immediate display)
  const r2Value = `${R2_AVATAR_PREFIX}${r2Key}`;
  const avatarUrl = await storageService.getAvatarUrl(r2Key);
  return c.json({ avatarUrl, r2Key: r2Value });
});
