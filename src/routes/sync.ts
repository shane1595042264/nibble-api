import { Hono } from 'hono';
import { z } from 'zod';
import { syncService } from '../services/sync.service.js';
import { AppError } from '../lib/errors.js';

export const syncRoutes = new Hono();

// ─── Zod schemas ────────────────────────────────────────────────────

const syncEntitySchema = z.object({
  id: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
}).passthrough();

const syncPayloadSchema = z.object({
  lastSyncedAt: z.string(),
  changes: z.object({
    books: z.array(syncEntitySchema).default([]),
    chapters: z.array(syncEntitySchema).default([]),
    sections: z.array(syncEntitySchema).default([]),
    vocabulary: z.array(syncEntitySchema).default([]),
    settings: z.record(z.string(), z.unknown()).nullable().default(null),
    exerciseProgress: z.array(syncEntitySchema).default([]),
  }),
});

// ─── Routes ─────────────────────────────────────────────────────────

syncRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = syncPayloadSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const result = await syncService.sync(user.id, parsed.data);
  return c.json(result);
});
