import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoMock = vi.hoisted(() => ({
  listKeys: vi.fn(),
  getSettings: vi.fn(),
  updateKey: vi.fn(),
  recordUsage: vi.fn(),
  upsertKey: vi.fn(),
  getKey: vi.fn(),
}));
vi.mock('../../../src/ai/repo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/repo.js')>()),
  ...repoMock,
}));

const providerMock = vi.hoisted(() => ({ generate: vi.fn(), listModels: vi.fn() }));
vi.mock('../../../src/ai/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/providers.js')>()),
  ...providerMock,
}));

const { ProviderError } = await import('../../../src/ai/providers.js');
const { sealKey, openKey } = await import('../../../src/ai/crypto.js');
const { candidatesFor, runAi, addKey, KeyCheckError } = await import('../../../src/ai/service.js');
type KeyRow = import('../../../src/ai/repo.js').KeyRow;

const USER = '11111111-1111-4111-8111-111111111111';
const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

let seq = 0;
function key(provider: string, over: Partial<KeyRow> = {}): KeyRow {
  seq++;
  return {
    id: `00000000-0000-4000-8000-00000000000${seq}`,
    userId: USER,
    provider,
    keySealed: sealKey(`${provider}-secret-${seq}`),
    baseUrl: null,
    keyHint: 'abcd',
    models: [],
    defaultModel: 'm',
    preferredModel: null,
    status: 'ok',
    lastError: null,
    lastCheckedAt: new Date(),
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repoMock.getSettings.mockResolvedValue({ preferredProvider: null });
  repoMock.updateKey.mockResolvedValue(null);
});

describe('candidatesFor', () => {
  it('puts the preferred provider first, skips failing keys, and uses the picked model', () => {
    const gem = key('gemini', { defaultModel: 'gemini-2.5-flash-lite' });
    const oai = key('openai', { defaultModel: 'gpt-4.1-nano', preferredModel: 'gpt-4o-mini' });
    const bad = key('anthropic', { status: 'failing' });
    const c = candidatesFor([gem, oai, bad], { preferredProvider: 'openai' }, false);
    expect(c.map((x) => [x.provider, x.model])).toEqual([
      ['openai', 'gpt-4o-mini'],
      ['gemini', 'gemini-2.5-flash-lite'],
    ]);
  });

  it('for images, swaps a text-only pick for the cheapest image-capable model on the key, and drops keys without one', () => {
    const oai = key('openai', { defaultModel: 'o3-mini', models: ['o3-mini', 'gpt-4.1-nano', 'gpt-4o'] });
    const grok = key('xai', { defaultModel: 'grok-3-mini', models: ['grok-3-mini'] });
    const c = candidatesFor([grok, oai], { preferredProvider: null }, true);
    expect(c.map((x) => [x.provider, x.model])).toEqual([['openai', 'gpt-4.1-nano']]);
  });
});

describe('runAi', () => {
  it('runs on the reader key, returns the answer and meters the call with its cost', async () => {
    const k = key('anthropic', { defaultModel: 'claude-haiku-4-5-20251001' });
    repoMock.listKeys.mockResolvedValue([k]);
    providerMock.generate.mockResolvedValue({ text: 'bonjour', inputTokens: 1000, outputTokens: 100, truncated: false });

    const r = await runAi(USER, 'translate-word', { prompt: 'hello', maxTokens: 50 });

    expect(r).toMatchObject({ text: 'bonjour', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', costMicroUsd: 1500 });
    // The decrypted key, not the sealed blob, is what reaches the provider.
    expect(providerMock.generate.mock.calls[0][1]).toBe(openKey(k.keySealed));
    expect(repoMock.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, provider: 'anthropic', feature: 'translate-word', inputTokens: 1000, outputTokens: 100, costMicroUsd: 1500,
    }));
  });

  it('with no key at all, asks for one (AI_KEY_REQUIRED, 409) without calling anything', async () => {
    repoMock.listKeys.mockResolvedValue([]);
    const err = await runAi(USER, 'ocr', { prompt: 'p', maxTokens: 5 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'AI_KEY_REQUIRED', status: 409 });
    expect(providerMock.generate).not.toHaveBeenCalled();
  });

  it('names a key that stopped working instead of asking for a new one', async () => {
    repoMock.listKeys.mockResolvedValue([key('openai', { status: 'failing', lastError: 'invalid key' })]);
    const err = await runAi(USER, 'translate-word', { prompt: 'p', maxTokens: 5 }).catch((e) => e);
    expect(err.code).toBe('AI_KEY_REQUIRED');
    expect(err.message).toMatch(/OpenAI key stopped working \(invalid key\)/);
  });

  it('with only text-only keys, a page-image call says so (AI_KEY_NO_VISION)', async () => {
    repoMock.listKeys.mockResolvedValue([key('xai', { defaultModel: 'grok-3-mini', models: ['grok-3-mini'] })]);
    const err = await runAi(USER, 'ocr', { prompt: 'p', images: [IMG], maxTokens: 5 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'AI_KEY_NO_VISION', status: 409 });
  });

  it('marks a refused key failing and falls through to the next key', async () => {
    const refused = key('openai', { defaultModel: 'gpt-4.1-nano' });
    const good = key('gemini', { defaultModel: 'gemini-2.5-flash-lite' });
    repoMock.listKeys.mockResolvedValue([refused, good]);
    providerMock.generate
      .mockRejectedValueOnce(new ProviderError('quota', 429, 'You exceeded your current quota'))
      .mockResolvedValueOnce({ text: 'ok', inputTokens: 1, outputTokens: 1, truncated: false });

    const r = await runAi(USER, 'explain-content', { prompt: 'p', maxTokens: 5 });

    expect(r.provider).toBe('gemini');
    expect(repoMock.updateKey).toHaveBeenCalledWith(
      USER, refused.id, { status: 'failing', lastError: 'You exceeded your current quota' }, refused.keySealed,
    );
  });

  it('reports a rate limit straight away without spending the next key', async () => {
    repoMock.listKeys.mockResolvedValue([key('openai'), key('gemini')]);
    providerMock.generate.mockRejectedValueOnce(new ProviderError('rate', 429, 'slow down'));
    const err = await runAi(USER, 'translate-word', { prompt: 'p', maxTokens: 5 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'AI_RATE_LIMITED', status: 429 });
    expect(providerMock.generate).toHaveBeenCalledTimes(1);
    expect(repoMock.updateKey).not.toHaveBeenCalled();
  });

  it('a timeout is a 503 the reader can retry', async () => {
    repoMock.listKeys.mockResolvedValue([key('gemini')]);
    providerMock.generate.mockRejectedValueOnce(new ProviderError('timeout', 0, 'The provider did not answer within 90s'));
    const err = await runAi(USER, 'ocr', { prompt: 'p', maxTokens: 5 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'AI_UNAVAILABLE', status: 503 });
  });

  it('a stored key that no longer decrypts is marked failing and the reader is asked to add it again', async () => {
    const broken = key('anthropic', { keySealed: Buffer.from('not a sealed key at all, just bytes').toString('base64') });
    repoMock.listKeys.mockResolvedValue([broken]);
    const err = await runAi(USER, 'ocr', { prompt: 'p', maxTokens: 5 }).catch((e) => e);
    expect(err.code).toBe('AI_KEY_REQUIRED');
    expect(err.message).toMatch(/could not be read/);
    expect(repoMock.updateKey).toHaveBeenCalledWith(USER, broken.id, expect.objectContaining({ status: 'failing' }), broken.keySealed);
  });
});

describe('addKey', () => {
  it('detects the provider, proves the cheapest model answers, then stores the key sealed', async () => {
    providerMock.listModels.mockResolvedValue(['gpt-4o', 'gpt-4.1-nano', 'text-embedding-3-small']);
    providerMock.generate
      .mockRejectedValueOnce(new ProviderError('model', 404, 'model not available to new users'))
      .mockResolvedValueOnce({ text: 'ok', inputTokens: 3, outputTokens: 1, truncated: false });
    repoMock.upsertKey.mockImplementation(async (row) => ({ id: 'k1', ...row }));
    const raw = 'sk-proj-' + 'q'.repeat(40);

    const row = await addKey(USER, `  ${raw} `);

    expect(row.provider).toBe('openai');
    expect(row.models).toEqual(['gpt-4.1-nano', 'gpt-4o']);
    expect(row.defaultModel).toBe('gpt-4o'); // the cheapest refused, the next one answered
    expect(row.keyHint).toBe('qqqq');
    expect(row.keySealed).not.toContain(raw);
    expect(openKey(row.keySealed)).toBe(raw);
    expect(row.baseUrl).toBeNull();
    expect(repoMock.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'validate', model: 'gpt-4o' }));
  });

  it('accepts a Gemini "AQ." key, the format AI Studio issues now', async () => {
    providerMock.listModels.mockResolvedValue(['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
    providerMock.generate.mockResolvedValue({ text: 'ok', inputTokens: 3, outputTokens: 1, truncated: false });
    repoMock.upsertKey.mockImplementation(async (row) => ({ id: 'k1', ...row }));
    const row = await addKey(USER, 'AQ.Ab8R' + 'n'.repeat(45));
    expect(row).toMatchObject({ provider: 'gemini', defaultModel: 'gemini-2.5-flash-lite' });
  });

  it('a shared sk- format: asks the likely owners in turn and keeps the first that accepts it', async () => {
    const raw = 'sk-' + '0123456789abcdef'.repeat(2); // DeepSeek and Qwen both issue this shape
    providerMock.listModels.mockImplementation(async (provider: string, _k: string, opts: { baseUrl?: string }) => {
      if (provider === 'deepseek') throw new ProviderError('auth', 401, 'Authentication Fails');
      if (provider === 'qwen' && opts.baseUrl?.includes('dashscope-intl')) throw new ProviderError('auth', 401, 'Incorrect API key provided');
      return ['qwen-flash', 'qwen-plus'];
    });
    providerMock.generate.mockResolvedValue({ text: 'ok', inputTokens: 3, outputTokens: 1, truncated: false });
    repoMock.upsertKey.mockImplementation(async (row) => ({ id: 'k1', ...row }));

    const row = await addKey(USER, raw);

    expect(providerMock.listModels.mock.calls.map((c) => [c[0], c[2].baseUrl])).toEqual([
      ['deepseek', 'https://api.deepseek.com/v1'],
      ['qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
      ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ]);
    // Found on Qwen's China server: that's where every later call goes.
    expect(row).toMatchObject({ provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-flash' });
    expect(providerMock.generate.mock.calls[0][4]).toEqual({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  });

  it('when no candidate accepts the key, names them all and suggests picking the provider', async () => {
    providerMock.listModels.mockRejectedValue(new ProviderError('auth', 401, 'nope'));
    const err = await addKey(USER, 'sk-' + '0123456789abcdef'.repeat(2)).catch((e) => e);
    expect(err.code).toBe('auth');
    expect(err.message).toMatch(/^DeepSeek or Qwen \(Alibaba Model Studio\) did not accept this key\. If it is from another provider, choose/);
    expect(repoMock.upsertKey).not.toHaveBeenCalled();
  });

  it("the reader's pick wins: only that provider sees the key, even for a format we can't place", async () => {
    providerMock.listModels.mockResolvedValue(['mistral-small-latest']);
    providerMock.generate.mockResolvedValue({ text: 'ok', inputTokens: 3, outputTokens: 1, truncated: false });
    repoMock.upsertKey.mockImplementation(async (row) => ({ id: 'k1', ...row }));
    const row = await addKey(USER, 'some-new-format-' + 'k'.repeat(30), 'mistral');
    expect(row.provider).toBe('mistral');
    expect(providerMock.listModels.mock.calls.map((c) => c[0])).toEqual(['mistral']);
  });

  it('an unplaceable key with no pick asks for the provider before calling anyone', async () => {
    const err = await addKey(USER, 'some-new-format-' + 'k'.repeat(30)).catch((e) => e);
    expect(err).toBeInstanceOf(KeyCheckError);
    expect(err.code).toBe('unknown_provider');
    expect(err.message).toMatch(/Choose its provider/);
    expect(providerMock.listModels).not.toHaveBeenCalled();
  });

  it('an admin key is refused even when the reader picks a provider', async () => {
    const err = await addKey(USER, 'sk-ant-admin01-' + 'x'.repeat(40), 'anthropic').catch((e) => e);
    expect(err.code).toBe('unknown_provider');
    expect(providerMock.listModels).not.toHaveBeenCalled();
  });

  it('a Groq key, refused before, is now detected and checked', async () => {
    providerMock.listModels.mockResolvedValue(['whisper-large-v3', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b']);
    providerMock.generate.mockResolvedValue({ text: 'ok', inputTokens: 3, outputTokens: 1, truncated: false });
    repoMock.upsertKey.mockImplementation(async (row) => ({ id: 'k1', ...row }));
    const row = await addKey(USER, 'gsk_' + 'z'.repeat(40));
    expect(row.provider).toBe('groq');
    expect(row.models).not.toContain('whisper-large-v3');
    expect(row.defaultModel).toBe('openai/gpt-oss-20b'); // the preferred default, not the 8B
  });

  it('tells a valid key without credit apart from a wrong key', async () => {
    providerMock.listModels.mockResolvedValue(['claude-haiku-4-5-20251001']);
    providerMock.generate.mockRejectedValueOnce(new ProviderError('quota', 400, 'Your credit balance is too low'));
    const err = await addKey(USER, 'sk-ant-api03-' + 'w'.repeat(40)).catch((e) => e);
    expect(err.code).toBe('quota');
    expect(repoMock.upsertKey).not.toHaveBeenCalled();
  });
});

describe('reader-facing copy', () => {
  it("never doubles the provider's own full stop", async () => {
    repoMock.listKeys.mockResolvedValue([key('gemini', { defaultModel: 'gemini-2.5-flash-lite' })]);
    providerMock.generate.mockRejectedValueOnce(new ProviderError('auth', 400, 'API key not valid. Please pass a valid API key.'));
    const err = await runAi(USER, 'translate-word', { prompt: 'p', maxTokens: 5 }).catch((e) => e);
    expect(err.message).toBe('Google Gemini rejected your key: API key not valid. Please pass a valid API key. Check it in Settings > AI.');
  });
});
