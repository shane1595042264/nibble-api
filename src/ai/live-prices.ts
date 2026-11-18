// List prices (and image support) from a maintained public price file, refreshed
// daily. Ported from shaneBackend modules/ai/live-prices.ts (SHAN-703).
//
// No provider publishes a pricing API, and their responses carry token counts,
// never cost. LiteLLM's model_prices_and_context_window.json is the closest
// thing to one: maintained by the LiteLLM project, updated within days of a
// price change, and keyed by the exact model ids the providers' own APIs return
// (Gemini and xAI behind a "gemini/" or "xai/" prefix). Nibbler also reads its
// `supports_vision` flag, because OCR and table-of-contents reading send page
// images and need a model that can see them.
//
// The snapshot lives in memory. Boot fetches it; an hourly check re-fetches it
// once it is a day old. When it cannot be had, catalog.ts falls back to its
// built-in table, then to tier guesses.

import { AI_PROVIDERS, PROVIDER_SPECS, type AiProvider } from './registry.js';

export const LIVE_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** OpenRouter publishes its own catalogue, with prices and input modalities, without a key. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const LIVE_PRICES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Fewer models than this means a truncated or wrong file; keep what we had. */
const MIN_MODELS = 50;

/** USD per million tokens, plus whether the model accepts images (when the file says). */
export interface LiveModel {
  input: number;
  output: number;
  vision?: boolean;
}

type PriceTable = Map<AiProvider, Map<string, LiveModel>>;

let snapshot: { prices: PriceTable; fetchedAt: Date; count: number } | null = null;
let inFlight: Promise<boolean> | null = null;

/** LiteLLM's litellm_provider value → ours, for every provider registry.ts prices from it. */
const PROVIDERS: Record<string, AiProvider> = {
  anthropic: 'anthropic',
  gemini: 'gemini',
  ...Object.fromEntries(
    AI_PROVIDERS.filter((p) => PROVIDER_SPECS[p].litellm).map((p) => [PROVIDER_SPECS[p].litellm!.provider, p]),
  ),
};

/**
 * The price file, reduced to chat models of the providers we support. Keys come
 * as "<provider>/<model id>" or bare; ids that still contain a "/" are resold
 * copies, except on providers whose own model ids have one (Groq, Together...).
 */
export function parseLiteLlmPrices(json: unknown): PriceTable {
  const table: PriceTable = new Map();
  if (!json || typeof json !== 'object') return table;
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const provider = PROVIDERS[String(v.litellm_provider)];
    if (!provider || v.mode !== 'chat') continue;
    const input = v.input_cost_per_token;
    const output = v.output_cost_per_token;
    if (typeof input !== 'number' || typeof output !== 'number') continue;
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    const prefix = `${v.litellm_provider}/`;
    const id = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    const slashIds = PROVIDER_SPECS[provider].litellm?.slashIds ?? false;
    if (!id || (id.includes('/') && !slashIds) || id === 'sample_spec') continue;
    let byId = table.get(provider);
    if (!byId) table.set(provider, (byId = new Map()));
    const model: LiveModel = { input: round(input * 1e6), output: round(output * 1e6) };
    if (typeof v.supports_vision === 'boolean') model.vision = v.supports_vision;
    byId.set(id, model);
  }
  return table;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** OpenRouter's /models: prices are per-token decimal strings; images when input_modalities says so. */
export function parseOpenRouterModels(json: unknown): Map<string, LiveModel> {
  const byId = new Map<string, LiveModel>();
  const list = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(list)) return byId;
  for (const raw of list) {
    const m = raw as { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; architecture?: { input_modalities?: unknown } };
    if (typeof m?.id !== 'string') continue;
    const input = Number(m.pricing?.prompt);
    const output = Number(m.pricing?.completion);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    const model: LiveModel = { input: round(input * 1e6), output: round(output * 1e6) };
    const modalities = m.architecture?.input_modalities;
    if (Array.isArray(modalities)) model.vision = modalities.includes('image');
    byId.set(m.id, model);
  }
  return byId;
}

async function fetchOpenRouter(fetchImpl: typeof fetch): Promise<Map<string, LiveModel> | null> {
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const byId = parseOpenRouterModels(await res.json());
    return byId.size > 0 ? byId : null;
  } catch (err) {
    console.warn('[ai] OpenRouter catalogue refresh failed:', (err as Error).message);
    return null;
  }
}

function countOf(table: PriceTable): number {
  let n = 0;
  for (const byId of table.values()) n += byId.size;
  return n;
}

/** Fetch and swap in a new snapshot. Never throws; concurrent callers share one request. */
export function refreshLivePrices(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const openRouter = fetchOpenRouter(fetchImpl);
      const res = await fetchImpl(LIVE_PRICES_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const prices = parseLiteLlmPrices(await res.json());
      const count = countOf(prices);
      if (count < MIN_MODELS) throw new Error(`only ${count} first-party chat models in the file`);
      // OpenRouter's own catalogue, or the one we had if it can't be fetched now.
      const openRouterPrices = (await openRouter) ?? snapshot?.prices.get('openrouter') ?? null;
      if (openRouterPrices) prices.set('openrouter', openRouterPrices);
      snapshot = { prices, fetchedAt: new Date(), count: countOf(prices) };
      console.log(`[ai] live prices refreshed: ${snapshot.count} models`);
      return true;
    } catch (err) {
      console.warn('[ai] live price refresh failed, keeping the previous prices:', (err as Error).message);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Refresh only when there is no snapshot or it is a day old. */
export function refreshLivePricesIfStale(now = Date.now()): Promise<boolean> {
  if (snapshot && now - snapshot.fetchedAt.getTime() < LIVE_PRICES_MAX_AGE_MS) return Promise.resolve(true);
  return refreshLivePrices();
}

/**
 * The live entry for a model id: an exact match, else the longest listed id the
 * given one extends at a "-" or "@" boundary, so a dated
 * "claude-haiku-5-5-20261001" finds "claude-haiku-5-5" but "gpt-5.5" never
 * takes "gpt-5"'s price.
 */
export function liveModelOf(provider: AiProvider, id: string): LiveModel | null {
  const byId = snapshot?.prices.get(provider);
  if (!byId) return null;
  const exact = byId.get(id);
  if (exact) return exact;
  let best: string | null = null;
  for (const key of byId.keys()) {
    if (key.length >= id.length || !id.startsWith(key)) continue;
    const next = id[key.length];
    if (next !== '-' && next !== '@') continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? byId.get(best)! : null;
}

export interface LivePricesStatus {
  source: 'live' | 'builtin';
  updatedAt: string | null;
  models: number;
}

export function livePricesStatus(): LivePricesStatus {
  return snapshot
    ? { source: 'live', updatedAt: snapshot.fetchedAt.toISOString(), models: snapshot.count }
    : { source: 'builtin', updatedAt: null, models: 0 };
}

let started = false;

/** Fetch at boot, then check hourly and re-fetch once the snapshot is a day old. */
export function startLivePrices(): void {
  if (started) return;
  started = true;
  void refreshLivePrices();
  setInterval(() => void refreshLivePricesIfStale(), 60 * 60 * 1000);
}

/** Tests only. */
export function __setLivePricesForTest(table: PriceTable | null, fetchedAt = new Date()): void {
  snapshot = table ? { prices: table, fetchedAt, count: countOf(table) } : null;
}
