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
    expect(repoMock.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'validate', model: 'gpt-4o' }));
  });

  it('refuses an unrecognised key before calling any provider', async () => {
    const err = await addKey(USER, 'gsk_' + 'z'.repeat(40)).catch((e) => e);
    expect(err).toBeInstanceOf(KeyCheckError);
    expect(err.code).toBe('unknown_provider');
    expect(providerMock.listModels).not.toHaveBeenCalled();
  });

  it('tells a valid key without credit apart from a wrong key', async () => {
    providerMock.listModels.mockResolvedValue(['claude-haiku-4-5-20251001']);
    providerMock.generate.mockRejectedValueOnce(new ProviderError('quota', 400, 'Your credit balance is too low'));
    const err = await addKey(USER, 'sk-ant-api03-' + 'w'.repeat(40)).catch((e) => e);
    expect(err.code).toBe('quota');
    expect(repoMock.upsertKey).not.toHaveBeenCalled();
  });
});
