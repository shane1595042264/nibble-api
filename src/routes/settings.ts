import { Hono } from 'hono';
import { z } from 'zod';
import { settingsRepository } from '../repositories/settings.repository.js';
import { AppError } from '../lib/errors.js';

export const settingsRoutes = new Hono();

// ─── Zod schemas ───────────────────────────────────────────────────

// Enum contracts must match the frontend types in WordByWord/src/lib/services/settings-service.ts.
// Without these the reader UI silently falls through to wrong branches on a bad value.
export const VIEW_MODES = ['pdf', 'text', 'side-by-side'] as const;
export const READING_MODES = ['scroll', 'flip'] as const;
export const TRACKING_MODES = ['timer', 'endofpage'] as const;

export const settingsPayloadSchema = z.object({
  autoReadThresholdSeconds: z.coerce.number().int().min(1).max(3600).optional(),
  defaultViewMode: z.enum(VIEW_MODES).optional(),
  readingMode: z.enum(READING_MODES).optional(),
  trackingMode: z.enum(TRACKING_MODES).optional(),
  targetLanguage: z.string().optional(),
  keymapOverrides: z.record(z.string(), z.unknown()).optional(),
});

const upsertSettingsSchema = settingsPayloadSchema;

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
