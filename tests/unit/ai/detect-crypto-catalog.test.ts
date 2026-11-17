import { describe, it, expect, afterEach } from 'vitest';
import { detectProvider, keyHint } from '../../../src/ai/detect.js';
import { openKey, sealKey } from '../../../src/ai/crypto.js';
import { costMicroUsd, priceOf, rankModels, supportsImages } from '../../../src/ai/catalog.js';
import { __setLivePricesForTest, parseLiteLlmPrices } from '../../../src/ai/live-prices.js';

const pad = (prefix: string) => prefix + 'x'.repeat(40);

describe('detectProvider', () => {
  it.each([
    ['sk-ant-api03-' + 'a'.repeat(40), 'anthropic'],
    ['sk-proj-' + 'b'.repeat(40), 'openai'],
    ['xai-' + 'c'.repeat(40), 'xai'],
    ['AIza' + 'D'.repeat(35), 'gemini'],
  ])('detects %s as %s', (key, provider) => {
    expect(detectProvider(key)).toEqual({ provider });
  });

  it('checks Anthropic before the bare sk- that means OpenAI', () => {
    expect(detectProvider(pad('sk-ant-'))).toEqual({ provider: 'anthropic' });
  });

  it.each([
    [pad('sk-ant-admin01-'), /Admin key/],
    [pad('sk-or-v1-'), /OpenRouter/],
    [pad('gsk_'), /Groq key/],
    [pad('sk-admin-'), /Admin key/],
    ['short', /too short/],
    ['sk-ant-abc def ' + 'x'.repeat(30), /no spaces/],
    ['hello-' + 'z'.repeat(40), /Could not tell/],
  ])('refuses %s with a reason that names the mistake', (key, reason) => {
    const d = detectProvider(key);
    expect(d.provider).toBeNull();
    expect((d as { reason: string }).reason).toMatch(reason);
  });

  it('trims the pasted key and hints with its last four characters', () => {
    expect(detectProvider(`  ${pad('xai-')}  `)).toEqual({ provider: 'xai' });
    expect(keyHint('  sk-ant-abcdefWXYZ  ')).toBe('WXYZ');
  });
});

describe('sealKey / openKey', () => {
  it('round-trips, and never stores the same ciphertext twice', () => {
    const key = pad('sk-ant-');
    const a = sealKey(key);
    const b = sealKey(key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-ant-');
    expect(openKey(a)).toBe(key);
    expect(openKey(b)).toBe(key);
  });

  it('refuses a tampered blob instead of returning garbage', () => {
    const raw = Buffer.from(sealKey(pad('sk-')), 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => openKey(raw.toString('base64'))).toThrow();
  });
});

describe('catalog', () => {
  afterEach(() => __setLivePricesForTest(null));

  it('ranks text models cheapest first and drops non-text ones', () => {
    const ranked = rankModels('openai', ['gpt-4o', 'text-embedding-3-small', 'gpt-4.1-nano', 'whisper-1', 'gpt-4o-mini']);
    expect(ranked).toEqual(['gpt-4.1-nano', 'gpt-4o-mini', 'gpt-4o']);
  });

  it('knows which families can read page images', () => {
    expect(supportsImages('anthropic', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(supportsImages('gemini', 'gemini-2.5-flash-lite')).toBe(true);
    expect(supportsImages('openai', 'gpt-4.1-nano')).toBe(true);
    expect(supportsImages('openai', 'o3-mini')).toBe(false);
    expect(supportsImages('openai', 'gpt-3.5-turbo')).toBe(false);
    expect(supportsImages('xai', 'grok-3-mini')).toBe(false);
    expect(supportsImages('xai', 'grok-4-fast-reasoning')).toBe(true);
  });

  it("prefers the live price file's own vision flag and price over the built-in guesses", () => {
    __setLivePricesForTest(parseLiteLlmPrices({
      'grok-3-mini': { litellm_provider: 'xai', mode: 'chat', input_cost_per_token: 3e-7, output_cost_per_token: 5e-7, supports_vision: true },
      'xai/grok-3-mini': { litellm_provider: 'xai', mode: 'chat', input_cost_per_token: 3e-7, output_cost_per_token: 5e-7, supports_vision: true },
    }));
    expect(supportsImages('xai', 'grok-3-mini')).toBe(true);
    expect(priceOf('xai', 'grok-3-mini')).toMatchObject({ input: 0.3, output: 0.5, source: 'live' });
  });

  it('prices a call in micro-dollars, estimating models no list knows', () => {
    // claude-haiku-4-5: $1 / $5 per million tokens.
    expect(costMicroUsd('anthropic', 'claude-haiku-4-5-20251001', 1000, 100)).toBe(1500);
    expect(priceOf('gemini', 'gemini-9-ultra-lite')).toMatchObject({ known: false, source: 'estimate' });
  });
});
