import { Hono } from 'hono';
import { z } from 'zod';
import { settingsRepository } from '../repositories/settings.repository.js';
import { AppError } from '../lib/errors.js';

export const settingsRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

const upsertSettingsSchema = z.object({
  autoReadThresholdSeconds: z.coerce.number().int().optional(),
  defaultViewMode: z.string().optional(),
  readingMode: z.string().optional(),
  trackingMode: z.string().optional(),
  targetLanguage: z.string().optional(),
  keymapOverrides: z.record(z.string(), z.unknown()).optional(),
});

// ─── Default settings returned when none exist ─────────────────────

const DEFAULT_SETTINGS = {
  autoReadThresholdSeconds: 5,
  defaultViewMode: 'pdf',
  readingMode: 'scroll',
  trackingMode: 'timer',
  targetLanguage: null,
  keymapOverrides: {},
};

// ─── Routes ────────────────────────────────────────────────────────

settingsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const settings = await settingsRepository.findByUserId(user.id);
  if (!settings) {
    return c.json({ userId: user.id, ...DEFAULT_SETTINGS });
  }
  return c.json(settings);
});

settingsRoutes.put('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = upsertSettingsSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', parsed.error.message, 400);
  }
  const settings = await settingsRepository.upsert(user.id, parsed.data);
  return c.json(settings);
});
