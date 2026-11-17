// Storage for readers' AI keys, their AI settings and usage events. Ported from
// shaneBackend modules/ai/repo.ts (SHAN-596 / SHAN-600).

import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiUsageEvents, userAiKeys, userAiSettings } from '../db/schema.js';
import { supportsImages } from './catalog.js';
import { AI_PROVIDERS, type AiProvider } from './detect.js';
import { livePricesStatus } from './live-prices.js';

export interface KeyRow {
  id: string;
  userId: string;
  provider: string;
  keySealed: string;
  keyHint: string;
  models: unknown;
  defaultModel: string;
  preferredModel: string | null;
  status: string;
  lastError: string | null;
  lastCheckedAt: Date;
  createdAt: Date;
}

export interface AiSettings {
  preferredProvider: AiProvider | null;
}

export function modelsOf(row: Pick<KeyRow, 'models'>): string[] {
  return Array.isArray(row.models) ? (row.models as string[]) : [];
}

/** The shape Settings sees: never the sealed key. */
export function publicKey(row: KeyRow) {
  const models = modelsOf(row);
  const provider = row.provider as AiProvider;
  const known = (AI_PROVIDERS as string[]).includes(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    keyHint: row.keyHint,
    models,
    /** Models on this key that can read page images (OCR, tables of contents, figures). */
    imageModels: known ? models.filter((m) => supportsImages(provider, m)) : [],
    defaultModel: row.defaultModel,
    preferredModel: row.preferredModel,
    status: row.status,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
  };
}

export async function listKeys(userId: string): Promise<KeyRow[]> {
  return (await db
    .select()
    .from(userAiKeys)
    .where(eq(userAiKeys.userId, userId))
    .orderBy(asc(userAiKeys.createdAt))) as KeyRow[];
}

export async function getKey(userId: string, id: string): Promise<KeyRow | null> {
  const [row] = await db
    .select()
    .from(userAiKeys)
    .where(and(eq(userAiKeys.userId, userId), eq(userAiKeys.id, id)));
  return (row as KeyRow) ?? null;
}

/** One key per provider: adding a second Gemini key replaces the first, keeping its id. */
export async function upsertKey(input: {
  userId: string;
  provider: AiProvider;
  keySealed: string;
  keyHint: string;
  models: string[];
  defaultModel: string;
}): Promise<KeyRow> {
  const now = new Date();
  const [row] = await db
    .insert(userAiKeys)
    .values({ ...input, status: 'ok', lastError: null, lastCheckedAt: now })
    .onConflictDoUpdate({
      target: [userAiKeys.userId, userAiKeys.provider],
      set: {
        keySealed: input.keySealed,
        keyHint: input.keyHint,
        models: input.models,
        defaultModel: input.defaultModel,
        preferredModel: null,
        status: 'ok',
        lastError: null,
        lastCheckedAt: now,
      },
    })
    .returning();
  return row as KeyRow;
}

/**
 * `expectSealed`: only write while the row still holds that key. Re-adding a
 * provider's key keeps the row id (the upsert above), so a write decided about
 * the old key after a slow provider call would otherwise land on the new one
 * (shaneBackend SHAN-600). Null when the row is gone or holds a different key.
 */
export async function updateKey(
  userId: string,
  id: string,
  patch: Partial<Pick<KeyRow, 'preferredModel' | 'status' | 'lastError' | 'defaultModel' | 'models' | 'lastCheckedAt'>>,
  expectSealed?: string,
): Promise<KeyRow | null> {
  const [row] = await db
    .update(userAiKeys)
    .set(patch)
    .where(
      and(
        eq(userAiKeys.userId, userId),
        eq(userAiKeys.id, id),
        expectSealed === undefined ? undefined : eq(userAiKeys.keySealed, expectSealed),
      ),
    )
    .returning();
  return (row as KeyRow) ?? null;
}

export async function deleteKey(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(userAiKeys)
    .where(and(eq(userAiKeys.userId, userId), eq(userAiKeys.id, id)))
    .returning({ id: userAiKeys.id });
  return rows.length > 0;
}

export async function getSettings(userId: string): Promise<AiSettings> {
  const [row] = await db.select().from(userAiSettings).where(eq(userAiSettings.userId, userId));
  return { preferredProvider: (row?.preferredProvider as AiProvider | null | undefined) ?? null };
}

/** Writes only the fields the patch carries (shaneBackend SHAN-600). */
export async function saveSettings(userId: string, patch: Partial<AiSettings>): Promise<AiSettings> {
  const set: { preferredProvider?: AiProvider | null; updatedAt: Date } = { updatedAt: new Date() };
  if (patch.preferredProvider !== undefined) set.preferredProvider = patch.preferredProvider;
  const [row] = await db
    .insert(userAiSettings)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: userAiSettings.userId, set })
    .returning();
  return { preferredProvider: (row.preferredProvider as AiProvider | null) ?? null };
}

export async function recordUsage(input: {
  userId: string;
  provider: AiProvider;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
}): Promise<void> {
  try {
    await db.insert(aiUsageEvents).values(input);
  } catch (err) {
    // Losing a usage row must never fail the call it describes.
    console.error('[ai] failed to record usage:', (err as Error).message);
  }
}

export async function usageSummary(userId: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const where = and(eq(aiUsageEvents.userId, userId), gte(aiUsageEvents.createdAt, since));
  const [totals, byModel, byFeature, daily, recent] = await Promise.all([
    db
      .select({
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint`,
      })
      .from(aiUsageEvents)
      .where(where),
    db
      .select({
        provider: aiUsageEvents.provider,
        model: aiUsageEvents.model,
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`sum(${aiUsageEvents.inputTokens})::int`,
        outputTokens: sql<number>`sum(${aiUsageEvents.outputTokens})::int`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(aiUsageEvents.provider, aiUsageEvents.model)
      .orderBy(desc(sql`sum(${aiUsageEvents.inputTokens}) + sum(${aiUsageEvents.outputTokens})`)),
    db
      .select({
        feature: aiUsageEvents.feature,
        calls: sql<number>`count(*)::int`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(aiUsageEvents.feature)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${aiUsageEvents.createdAt}), 'YYYY-MM-DD')`,
        tokens: sql<number>`sum(${aiUsageEvents.inputTokens} + ${aiUsageEvents.outputTokens})::int`,
        costMicroUsd: sql<number>`coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint`,
      })
      .from(aiUsageEvents)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({
        id: aiUsageEvents.id,
        provider: aiUsageEvents.provider,
        model: aiUsageEvents.model,
        feature: aiUsageEvents.feature,
        inputTokens: aiUsageEvents.inputTokens,
        outputTokens: aiUsageEvents.outputTokens,
        costMicroUsd: aiUsageEvents.costMicroUsd,
        createdAt: aiUsageEvents.createdAt,
      })
      .from(aiUsageEvents)
      .where(where)
      .orderBy(desc(aiUsageEvents.createdAt))
      .limit(25),
  ]);
  // bigint sums come back as strings from postgres-js; costs are small enough for a JS number.
  const num = (v: unknown) => Number(v ?? 0);
  return {
    days,
    totals: { ...totals[0], costMicroUsd: num(totals[0]?.costMicroUsd) },
    byModel: byModel.map((r) => ({ ...r, costMicroUsd: num(r.costMicroUsd) })),
    byFeature: byFeature.map((r) => ({ ...r, costMicroUsd: num(r.costMicroUsd) })),
    daily: daily.map((r) => ({ ...r, costMicroUsd: num(r.costMicroUsd) })),
    recent,
    prices: livePricesStatus(),
  };
}
