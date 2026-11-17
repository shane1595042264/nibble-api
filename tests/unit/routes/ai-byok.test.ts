import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// The /ai routes run every call on the reader's own key (2026-11-17). These
// cover the wiring: who the call runs for, the error mapping the reader sees,
// and the key-management routes' validation. src/ai/service.ts has its own tests.

const repoMock = vi.hoisted(() => ({
  listKeys: vi.fn(),
  getSettings: vi.fn(),
  getKey: vi.fn(),
  updateKey: vi.fn(),
  deleteKey: vi.fn(),
  saveSettings: vi.fn(),
  usageSummary: vi.fn(),
}));
vi.mock('../../../src/ai/repo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/repo.js')>()),
  ...repoMock,
}));

const serviceMock = vi.hoisted(() => ({ addKey: vi.fn(), recheckKey: vi.fn(), runAi: vi.fn() }));
vi.mock('../../../src/ai/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/service.js')>()),
  ...serviceMock,
}));

const { aiRoutes } = await import('../../../src/routes/ai.js');
const { errorHandler } = await import('../../../src/middleware/error-handler.js');
const { KeyCheckError } = await import('../../../src/ai/service.js');
const { AppError } = await import('../../../src/lib/errors.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '22222222-2222-4222-8222-222222222222';

function app() {
  const a = new Hono();
  a.onError(errorHandler);
  a.use('/ai/*', async (c, next) => {
    c.set('user', { id: USER_ID });
    await next();
  });
  a.route('/ai', aiRoutes);
  return a;
}

const post = (path: string, body: unknown) =>
  app().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe('reader AI calls run for the signed-in user', () => {
  it('translate-word runs on that user key and returns the parsed answer', async () => {
    serviceMock.runAi.mockResolvedValue({ text: '{"pronunciation":"/x/","translation":"你好","partOfSpeech":"n."}', truncated: false });
    const res = await post('/ai/translate-word', { word: 'hello', sentence: 'hello world', targetLanguage: 'Chinese' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pronunciation: '/x/', translation: '你好', partOfSpeech: 'n.' });
    expect(serviceMock.runAi).toHaveBeenCalledWith(USER_ID, 'translate-word', expect.objectContaining({ json: true }));
  });

  it('without a key the reader gets 409 AI_KEY_REQUIRED, not the old admin-only 402', async () => {
    serviceMock.runAi.mockRejectedValue(new AppError('AI_KEY_REQUIRED', 'Add your own AI key in Settings > AI to use this.', 409));
    const res = await post('/ai/explain-content', { content: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: 'AI_KEY_REQUIRED' });
  });

  it('explain-image refuses any host but Mathpix, before spending anything', async () => {
    const res = await post('/ai/explain-image', { imageUrl: 'http://169.254.169.254/latest/meta-data' });
    expect(res.status).toBe(400);
    expect(serviceMock.runAi).not.toHaveBeenCalled();
  });
});

describe('key management', () => {
  it.each([
    ['unknown_provider', 400, 'AI_KEY_UNKNOWN_PROVIDER'],
    ['auth', 422, 'AI_KEY_REJECTED'],
    ['quota', 422, 'AI_KEY_NO_CREDIT'],
    ['unreachable', 502, 'AI_PROVIDER_UNREACHABLE'],
  ] as const)('a %s key check answers %s %s with the reason', async (code, status, apiCode) => {
    serviceMock.addKey.mockRejectedValue(new KeyCheckError(code, 'because'));
    const res = await post('/ai/keys', { key: 'whatever' });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toEqual({ code: apiCode, message: 'because', status });
  });

  it('never returns the sealed key', async () => {
    serviceMock.addKey.mockResolvedValue({
      id: KEY_ID, userId: USER_ID, provider: 'gemini', keySealed: 'SEALED', keyHint: 'abcd', models: ['gemini-2.5-flash-lite'],
      defaultModel: 'gemini-2.5-flash-lite', preferredModel: null, status: 'ok', lastError: null, lastCheckedAt: new Date(), createdAt: new Date(),
    });
    const res = await post('/ai/keys', { key: 'AIza' + 'x'.repeat(35) });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(JSON.stringify(body)).not.toContain('SEALED');
    expect(body.key).toMatchObject({ provider: 'gemini', keyHint: 'abcd', imageModels: ['gemini-2.5-flash-lite'] });
  });

  it('refuses a preferred model the key never listed', async () => {
    repoMock.getKey.mockResolvedValue({ id: KEY_ID, models: ['a', 'b'], keySealed: 'S' });
    const res = await app().request(`/ai/keys/${KEY_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferredModel: 'c' }),
    });
    expect(res.status).toBe(400);
    expect(repoMock.updateKey).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid key id with 400 instead of reaching Postgres', async () => {
    const res = await app().request('/ai/keys/not-a-uuid', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(repoMock.deleteKey).not.toHaveBeenCalled();
  });

  it('usage clamps the window to 1-365 days', async () => {
    const res = await app().request('/ai/usage?days=9999');
    expect(res.status).toBe(400);
    repoMock.usageSummary.mockResolvedValue({ days: 7 });
    expect((await app().request('/ai/usage?days=7')).status).toBe(200);
    expect(repoMock.usageSummary).toHaveBeenCalledWith(USER_ID, 7);
  });
});

describe('shortcut search', () => {
  const shortcuts = [
    { id: 'normal:s', label: 'Sentence mode', description: 'Switch to sentence mode' },
    { id: 'view-pdf', label: 'PDF View', description: 'Switch to PDF view mode' },
  ];

  it('returns only ids from the catalog the browser sent, deduped', async () => {
    serviceMock.runAi.mockResolvedValue({ text: 'Sure: ["normal:s","made-up","normal:s",7,"view-pdf"]', truncated: false });
    const res = await post('/ai/search-shortcuts', { query: 'how do I switch modes', shortcuts });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: ['normal:s', 'view-pdf'] });
    expect(serviceMock.runAi).toHaveBeenCalledWith(USER_ID, 'search-shortcuts', expect.objectContaining({ json: true }));
  });

  it.each([
    ['a blank query', { query: '   ', shortcuts }],
    ['an empty catalog', { query: 'modes', shortcuts: [] }],
    ['an oversized catalog', { query: 'modes', shortcuts: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, label: 'x', description: 'x' })) }],
  ])('rejects %s with 400 before spending anything', async (_name, body) => {
    const res = await post('/ai/search-shortcuts', body);
    expect(res.status).toBe(400);
    expect(serviceMock.runAi).not.toHaveBeenCalled();
  });
});
