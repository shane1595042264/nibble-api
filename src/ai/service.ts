// Bring-your-own-key AI (2026-11-17). Adding a key (detect, list, find the
// cheapest model that really answers, seal, store) is ported from shaneBackend
// modules/ai/service.ts (SHAN-596). runAi is Nibbler's: every model call the
// app makes goes through it, on the reader's own key, and is metered.

import { AppError } from '../lib/errors.js';
import { costMicroUsd, rankModels, supportsImages } from './catalog.js';
import { openKey, sealKey } from './crypto.js';
import { AI_PROVIDERS, PROVIDER_LABEL, detectProvider, keyHint, type AiProvider } from './detect.js';
import { ProviderError, generate, listModels, type GenerateInput } from './providers.js';
import * as repo from './repo.js';

/** What a call was for; stored on every usage event. */
export type AiFeature =
  | 'validate'
  | 'translate-word'
  | 'translate-sentence'
  | 'explain-translation'
  | 'explain-content'
  | 'explain-image'
  | 'search-shortcuts'
  | 'ocr'
  | 'toc'
  | 'split-sections'
  | 'processing-ocr';

/** How many models the key check will try before giving up on a key. */
const MAX_PROBES = 4;

export class KeyCheckError extends Error {
  constructor(
    readonly code: 'unknown_provider' | 'auth' | 'quota' | 'no_models' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'KeyCheckError';
  }
}

/**
 * Proves a key works by spending one output token on the cheapest text model it
 * can list, falling through to the next cheapest when a model is listed but
 * refused. "Valid" alone is not the bar: a key whose account has no credit
 * lists models happily and fails every real call, and that is the case worth
 * catching while the reader is still on the Settings page.
 */
export async function checkKey(provider: AiProvider, key: string, userId: string) {
  let listed: string[];
  try {
    listed = await listModels(provider, key);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') {
      throw new KeyCheckError('auth', `The provider rejected this key: ${err.message}`);
    }
    throw new KeyCheckError('unreachable', err instanceof Error ? err.message : 'Could not reach the provider');
  }
  const models = rankModels(provider, listed);
  if (models.length === 0) throw new KeyCheckError('no_models', 'This key cannot use any text model.');

  let lastError: ProviderError | null = null;
  for (const model of models.slice(0, MAX_PROBES)) {
    try {
      const r = await generate(provider, key, model, { system: 'Reply with one word.', prompt: 'ok', maxTokens: 8 });
      await repo.recordUsage({
        userId,
        provider,
        model,
        feature: 'validate',
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costMicroUsd: costMicroUsd(provider, model, r.inputTokens, r.outputTokens),
      });
      return { models, defaultModel: model };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      lastError = err;
      if (err.kind === 'auth') throw new KeyCheckError('auth', `The provider rejected this key: ${err.message}`);
      if (err.kind === 'quota') {
        throw new KeyCheckError('quota', `The key is valid but the account cannot run models: ${err.message}`);
      }
      // "model", "rate", "timeout", "other": try the next model.
    }
  }
  throw new KeyCheckError('no_models', `None of the cheapest models answered${lastError ? `: ${lastError.message}` : '.'}`);
}

export async function addKey(userId: string, rawKey: string) {
  const key = rawKey.trim();
  const detection = detectProvider(key);
  if (!detection.provider) throw new KeyCheckError('unknown_provider', detection.reason);
  const { models, defaultModel } = await checkKey(detection.provider, key, userId);
  return repo.upsertKey({
    userId,
    provider: detection.provider,
    keySealed: sealKey(key),
    keyHint: keyHint(key),
    models,
    defaultModel,
  });
}

/**
 * The result is written only if the row still holds the key that was checked:
 * a key added for the same provider meanwhile replaces this one in place.
 */
export async function recheckKey(userId: string, id: string) {
  const row = await repo.getKey(userId, id);
  if (!row) return null;
  let updated: repo.KeyRow | null;
  try {
    const { models, defaultModel } = await checkKey(row.provider as AiProvider, openKey(row.keySealed), userId);
    const keepPreferred = row.preferredModel && models.includes(row.preferredModel) ? row.preferredModel : null;
    updated = await repo.updateKey(
      userId,
      id,
      { models, defaultModel, preferredModel: keepPreferred, status: 'ok', lastError: null, lastCheckedAt: new Date() },
      row.keySealed,
    );
  } catch (err) {
    updated = await repo.updateKey(
      userId,
      id,
      { status: 'failing', lastError: err instanceof Error ? err.message : 'Check failed', lastCheckedAt: new Date() },
      row.keySealed,
    );
  }
  return updated ?? repo.getKey(userId, id);
}

// ---------------------------------------------------------------------------
// Running a model on the reader's key
// ---------------------------------------------------------------------------

export interface Candidate {
  row: repo.KeyRow;
  provider: AiProvider;
  model: string;
}

/**
 * The keys to try, in order, each with the model to use. Working keys only:
 * the preferred provider first, then in the order they were added. The model
 * is the one the reader picked for that key, else the cheapest that passed the
 * key check. A request carrying images needs a model that can read them: the
 * reader's pick if it can, else the cheapest image-capable model the key
 * listed; a key with none is skipped.
 */
export function candidatesFor(keys: repo.KeyRow[], settings: repo.AiSettings, needsImages: boolean): Candidate[] {
  const usable = keys.filter((k) => k.status === 'ok' && (AI_PROVIDERS as string[]).includes(k.provider));
  const ordered = [
    ...usable.filter((k) => k.provider === settings.preferredProvider),
    ...usable.filter((k) => k.provider !== settings.preferredProvider),
  ];
  const out: Candidate[] = [];
  for (const row of ordered) {
    const provider = row.provider as AiProvider;
    const picked = row.preferredModel ?? row.defaultModel;
    if (!needsImages) {
      out.push({ row, provider, model: picked });
      continue;
    }
    const model = supportsImages(provider, picked)
      ? picked
      : repo.modelsOf(row).find((m) => supportsImages(provider, m));
    if (model) out.push({ row, provider, model });
  }
  return out;
}

export interface RunInput extends Omit<GenerateInput, 'signal'> {
  signal?: AbortSignal;
}

export interface RunResult {
  text: string;
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  truncated: boolean;
}

function noKeyError(keys: repo.KeyRow[], needsImages: boolean): AppError {
  const failing = keys.find((k) => k.status !== 'ok');
  if (keys.some((k) => k.status === 'ok') && needsImages) {
    return new AppError(
      'AI_KEY_NO_VISION',
      'None of your AI keys has a model that can read page images. Add a Gemini, OpenAI or Anthropic key in Settings.',
      409,
    );
  }
  if (failing) {
    const label = PROVIDER_LABEL[failing.provider as AiProvider] ?? failing.provider;
    return new AppError(
      'AI_KEY_REQUIRED',
      `Your ${label} key stopped working${failing.lastError ? ` (${failing.lastError})` : ''}. Check it in Settings > AI.`,
      409,
    );
  }
  return new AppError('AI_KEY_REQUIRED', 'Add your own AI key in Settings > AI to use this.', 409);
}

function providerAppError(provider: AiProvider, err: ProviderError): AppError {
  const label = PROVIDER_LABEL[provider];
  // Provider messages usually end in a full stop ("API key not valid. Please
  // pass a valid API key."); drop it so the sentence we add doesn't read "..".
  const reason = err.message.replace(/[.\s]+$/, '');
  switch (err.kind) {
    case 'auth':
      return new AppError('AI_KEY_REJECTED', `${label} rejected your key: ${reason}. Check it in Settings > AI.`, 409);
    case 'quota':
      return new AppError('AI_KEY_REJECTED', `Your ${label} account can't run this: ${err.message}`, 409);
    case 'rate':
      return new AppError('AI_RATE_LIMITED', `${label} is rate-limiting your key. Wait a moment and try again.`, 429);
    case 'timeout':
      return new AppError('AI_UNAVAILABLE', `${label} did not answer in time. Try again.`, 503);
    default:
      return new AppError('AI_ERROR', `${label}: ${err.message}`, 502);
  }
}

/**
 * Run one model call for `userId` on their own key, record what it cost, and
 * return the answer. Keys are tried in candidatesFor order: a key the provider
 * refuses (auth or quota) is marked failing and the next one is tried, and so
 * is a model that has gone away; a rate limit, a timeout or any other upstream
 * failure is reported straight away. A client disconnect rethrows the
 * AbortError untouched, so routes can answer 499.
 */
export async function runAi(userId: string, feature: AiFeature, input: RunInput): Promise<RunResult> {
  const needsImages = (input.images?.length ?? 0) > 0;
  const [keys, settings] = await Promise.all([repo.listKeys(userId), repo.getSettings(userId)]);
  const candidates = candidatesFor(keys, settings, needsImages);
  if (candidates.length === 0) throw noKeyError(keys, needsImages);

  let lastError: AppError | null = null;
  for (const { row, provider, model } of candidates) {
    let key: string;
    try {
      key = openKey(row.keySealed);
    } catch {
      await repo.updateKey(userId, row.id, { status: 'failing', lastError: 'Stored key could not be read. Add it again.' }, row.keySealed);
      lastError = new AppError('AI_KEY_REQUIRED', 'Your saved AI key could not be read. Add it again in Settings > AI.', 409);
      continue;
    }
    try {
      const r = await generate(provider, key, model, input);
      const cost = costMicroUsd(provider, model, r.inputTokens, r.outputTokens);
      await repo.recordUsage({
        userId,
        provider,
        model,
        feature,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costMicroUsd: cost,
      });
      return {
        text: r.text,
        provider,
        model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costMicroUsd: cost,
        truncated: r.truncated,
      };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      lastError = providerAppError(provider, err);
      if (err.kind === 'auth' || err.kind === 'quota') {
        // Only the key that was refused: a key pasted in meanwhile keeps its "ok".
        await repo.updateKey(userId, row.id, { status: 'failing', lastError: err.message }, row.keySealed);
        continue;
      }
      if (err.kind === 'model') continue;
      throw lastError;
    }
  }
  throw lastError ?? noKeyError(keys, needsImages);
}
