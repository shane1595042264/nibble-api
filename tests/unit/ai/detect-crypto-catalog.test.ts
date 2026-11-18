import { describe, it, expect, afterEach } from 'vitest';
import { detectProviders, keyHint, providerList } from '../../../src/ai/detect.js';
import { openKey, sealKey } from '../../../src/ai/crypto.js';
import { costMicroUsd, priceOf, rankModels, supportsImages } from '../../../src/ai/catalog.js';
import { __setLivePricesForTest, parseLiteLlmPrices, parseOpenRouterModels } from '../../../src/ai/live-prices.js';
import { PROVIDER_SPECS, baseUrlOf, regionOf } from '../../../src/ai/registry.js';

const pad = (prefix: string) => prefix + 'x'.repeat(40);

describe('detectProviders', () => {
  it.each([
    ['sk-ant-api03-' + 'a'.repeat(40), ['anthropic']],
    ['sk-proj-' + 'b'.repeat(40), ['openai']],
    ['sk-' + 'Ab12'.repeat(5) + 'T3BlbkFJ' + 'Cd34'.repeat(5), ['openai']],
    ['xai-' + 'c'.repeat(40), ['xai']],
    ['AIza' + 'D'.repeat(35), ['gemini']],
    // Google AI Studio issues "AQ." keys now (the reader key that was refused on 2026-11-17).
    ['AQ.Ab8R' + 'n'.repeat(45), ['gemini']],
    ['sk-or-v1-' + 'e'.repeat(64), ['openrouter']],
    ['gsk_' + 'f'.repeat(52), ['groq']],
    ['csk-' + 'g'.repeat(48), ['cerebras']],
    ['fw_' + 'h'.repeat(24), ['fireworks']],
    ['pplx-' + 'i'.repeat(48), ['perplexity']],
    ['tgp_v1_' + 'j'.repeat(40), ['together']],
    ['0123456789abcdef'.repeat(4), ['together']],
    ['0123456789abcdef'.repeat(2) + '.AbCdEfGh12345678', ['zhipu']],
    ['AbCd1234'.repeat(4), ['mistral', 'deepinfra']],
  ])('%s → %j', (key, candidates) => {
    expect(detectProviders(key)).toEqual({ candidates });
  });

  it('a plain sk- key lists every provider that issues that format, most likely first', () => {
    expect(detectProviders('sk-' + '0123456789abcdef'.repeat(2)).candidates).toEqual(['deepseek', 'qwen']);
    expect(detectProviders('sk-' + 'q'.repeat(48)).candidates).toEqual(['siliconflow', 'moonshot', 'openai']);
    expect(detectProviders('sk-' + 'Mixed9Case'.repeat(5)).candidates).toEqual(['openai', 'deepseek', 'moonshot', 'qwen', 'siliconflow']);
  });

  it('checks the nested prefixes first: Anthropic and OpenRouter keys also start with sk-', () => {
    expect(detectProviders(pad('sk-ant-')).candidates).toEqual(['anthropic']);
    expect(detectProviders(pad('sk-or-')).candidates).toEqual(['openrouter']);
  });

  it.each([
    [pad('sk-ant-admin01-'), /Admin key/],
    [pad('sk-admin-'), /Admin key/],
    ['short', /too short/],
    ['sk-ant-abc def ' + 'x'.repeat(30), /no spaces/],
  ])('refuses %s outright, whatever provider is picked', (key, reason) => {
    const d = detectProviders(key);
    expect(d).toMatchObject({ candidates: [], fatal: true });
    expect(d.reason).toMatch(reason);
  });

  it('an unknown format is not refused: it asks for the provider instead', () => {
    const d = detectProviders('hello-' + 'z'.repeat(40));
    expect(d.candidates).toEqual([]);
    expect(d.fatal).toBeUndefined();
    expect(d.reason).toMatch(/Choose its provider/);
  });

  it('trims the pasted key and hints with its last four characters', () => {
    expect(detectProviders(`  ${pad('xai-')}  `).candidates).toEqual(['xai']);
    expect(keyHint('  sk-ant-abcdefWXYZ  ')).toBe('WXYZ');
    expect(providerList(['openai', 'deepseek', 'qwen'])).toBe('OpenAI, DeepSeek or Qwen (Alibaba Model Studio)');
  });
});

describe('registry', () => {
  it('a key stores its regional server only when it is not the default, and shows that region', () => {
    expect(baseUrlOf('qwen', null)).toBe(PROVIDER_SPECS.qwen.baseUrls[0]);
    expect(baseUrlOf('qwen', 'https://evil.example/v1')).toBe(PROVIDER_SPECS.qwen.baseUrls[0]);
    expect(regionOf('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('China');
    expect(regionOf('qwen', null)).toBeNull();
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

  it('reads prices for the other providers from the same file, keeping ids that contain a slash only where they belong', () => {
    __setLivePricesForTest(parseLiteLlmPrices({
      'groq/meta-llama/llama-4-scout-17b-16e-instruct': { litellm_provider: 'groq', mode: 'chat', input_cost_per_token: 1.1e-7, output_cost_per_token: 3.4e-7, supports_vision: true },
      'deepseek/deepseek-chat': { litellm_provider: 'deepseek', mode: 'chat', input_cost_per_token: 2.8e-7, output_cost_per_token: 4.2e-7 },
      'dashscope/qwen-flash': { litellm_provider: 'dashscope', mode: 'chat', input_cost_per_token: 5e-8, output_cost_per_token: 4e-7 },
      'mistral/some-org/resold': { litellm_provider: 'mistral', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    }));
    expect(priceOf('groq', 'meta-llama/llama-4-scout-17b-16e-instruct')).toMatchObject({ input: 0.11, source: 'live' });
    expect(supportsImages('groq', 'meta-llama/llama-4-scout-17b-16e-instruct')).toBe(true);
    expect(priceOf('deepseek', 'deepseek-chat')).toMatchObject({ output: 0.42, source: 'live' });
    expect(priceOf('qwen', 'qwen-flash')).toMatchObject({ input: 0.05, source: 'live' });
    expect(priceOf('mistral', 'some-org/resold').source).not.toBe('live');
  });

  it("OpenRouter's own catalogue gives its prices and image support", () => {
    const table = parseLiteLlmPrices({});
    table.set('openrouter', parseOpenRouterModels({
      data: [
        { id: 'google/gemini-2.5-flash-lite', pricing: { prompt: '0.0000001', completion: '0.0000004' }, architecture: { input_modalities: ['text', 'image'] } },
        { id: 'deepseek/deepseek-chat-v3.1', pricing: { prompt: '0.0000002', completion: '0.0000008' }, architecture: { input_modalities: ['text'] } },
      ],
    }));
    __setLivePricesForTest(table);
    expect(priceOf('openrouter', 'google/gemini-2.5-flash-lite')).toMatchObject({ input: 0.1, output: 0.4, source: 'live' });
    expect(supportsImages('openrouter', 'google/gemini-2.5-flash-lite')).toBe(true);
    expect(supportsImages('openrouter', 'deepseek/deepseek-chat-v3.1')).toBe(false);
  });

  it('on the many-model providers, the good cheap defaults come first and tiny or free models last', () => {
    const ranked = rankModels('openrouter', [
      'meta-llama/llama-3.2-1b-instruct',
      'some/model:free',
      'mistralai/mistral-7b-instruct',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-flash-lite',
      'openai/text-embedding-3-small',
      'google/gemini-2.5-flash-image',
    ]);
    expect(ranked.slice(0, 2)).toEqual(['google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini']);
    expect(ranked.slice(-2).sort()).toEqual(['meta-llama/llama-3.2-1b-instruct', 'some/model:free'].sort());
    expect(ranked).not.toContain('openai/text-embedding-3-small');
    expect(ranked).not.toContain('google/gemini-2.5-flash-image');
  });

  it('guesses image support from the name on the other providers', () => {
    expect(supportsImages('qwen', 'qwen-vl-plus')).toBe(true);
    expect(supportsImages('qwen', 'qwen-flash')).toBe(false);
    expect(supportsImages('mistral', 'pixtral-12b-2409')).toBe(true);
    expect(supportsImages('deepseek', 'deepseek-chat')).toBe(false);
  });

  it('prices a call in micro-dollars, estimating models no list knows', () => {
    // claude-haiku-4-5: $1 / $5 per million tokens.
    expect(costMicroUsd('anthropic', 'claude-haiku-4-5-20251001', 1000, 100)).toBe(1500);
    expect(priceOf('gemini', 'gemini-9-ultra-lite')).toMatchObject({ known: false, source: 'estimate' });
  });
});
