import { eq, gte, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userSettings } from '../db/schema.js';

// The only columns a caller may write. POST /api/sync hands over the client's
// blob as-is, so copying anything else would let a body userId or id land in
// values() and set: { userId: <victim> } then upserts the VICTIM's row (KAN-363).
const SETTINGS_FIELDS = [
  'autoReadThresholdSeconds',
  'defaultViewMode',
  'readingMode',
  'trackingMode',
  'targetLanguage',
  'keymapOverrides',
] as const;

export const settingsRepository = {
  async findByUserId(userId: string) {
    const [settings] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    return settings ?? null;
  },

  async upsert(
    userId: string,
    data: Partial<{
      autoReadThresholdSeconds: number;
      defaultViewMode: string;
      readingMode: string;
      trackingMode: string;
      targetLanguage: string;
      keymapOverrides: Record<string, unknown>;
    }>,
  ) {
    const fields: Record<string, unknown> = {};
    for (const k of SETTINGS_FIELDS) {
      if (data[k] !== undefined) fields[k] = data[k];
    }
    // Atomic upsert via INSERT ... ON CONFLICT (user_id). Replaces the previous
    // check-then-act (SELECT then INSERT/UPDATE), which raced the UNIQUE(user_id)
    // constraint when two concurrent first-writes both missed the SELECT.
    if (Object.keys(fields).length === 0) {
      // Nothing to write: ensure a row exists without a spurious updatedAt bump.
      const [row] = await db
        .insert(userSettings)
        .values({ userId })
        .onConflictDoNothing({ target: userSettings.userId })
        .returning();
      return row ?? (await this.findByUserId(userId));
    }
    // $onUpdate fires on .update() but NOT on onConflictDoUpdate, so set
    // updatedAt explicitly to keep findModifiedSince working across devices.
    const [row] = await db
      .insert(userSettings)
      .values({ ...fields, userId })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { ...fields, updatedAt: new Date() },
      })
      .returning();
    return row;
  },

  async findModifiedSince(userId: string, since: Date) {
    const [settings] = await db
      .select()
      .from(userSettings)
      .where(
        and(
          eq(userSettings.userId, userId),
          gte(userSettings.updatedAt, since),
        ),
      )
      .limit(1);
    return settings ?? null;
  },
};
