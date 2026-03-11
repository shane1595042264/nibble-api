import { eq, gte, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userSettings } from '../db/schema.js';

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
    const existing = await this.findByUserId(userId);
    if (existing) {
      const [updated] = await db
        .update(userSettings)
        .set(data)
        .where(eq(userSettings.userId, userId))
        .returning();
      return updated;
    }
    const [created] = await db
      .insert(userSettings)
      .values({ userId, ...data })
      .returning();
    return created;
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
