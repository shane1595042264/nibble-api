import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  buildKnowledgeText,
  buildKnowledgeSource,
  knowledgeEntryToLegacyVocab,
  type KnowledgeBaseEntry,
} from '../../../src/services/knowledge-base.service.js';

describe('buildKnowledgeText', () => {
  it('produces a minimal text when only word is present', () => {
    expect(buildKnowledgeText({ word: 'contextual' })).toBe('"contextual"');
  });

  it('joins word, translation, pronunciation, context into a classifier-friendly sentence', () => {
    const t = buildKnowledgeText({
      word: 'contextual',
      pronunciation: 'kən-ˈtek-ʃə-wəl',
      translation: '相关的',
      targetLanguage: 'zh',
      contextSentence: 'The contextual understanding is important.',
    });
    expect(t).toContain('"contextual" means "相关的"');
    expect(t).toContain('target language: zh');
    expect(t).toContain('pronounced [kən-ˈtek-ʃə-wəl]');
    expect(t).toContain('Context: "The contextual understanding is important."');
  });

  it('falls back to definition when translation is absent', () => {
    expect(
      buildKnowledgeText({ word: 'foo', definition: 'a placeholder name' })
    ).toContain('"foo" means "a placeholder name"');
  });
});

describe('buildKnowledgeSource', () => {
  it('always tags app=nibbler', () => {
    const s = buildKnowledgeSource({ word: 'x' });
    expect(s).toMatchObject({ app: 'nibbler', book: null, location: null });
  });

  it('joins section + page into location', () => {
    const s = buildKnowledgeSource({
      word: 'x',
      bookTitle: 'The Pragmatic Programmer',
      sectionTitle: 'Ch. 3',
      page: 87,
    });
    expect(s?.book).toBe('The Pragmatic Programmer');
    expect(s?.location).toBe('Ch. 3, page 87');
  });

  it('uses the context sentence as rawContext', () => {
    const s = buildKnowledgeSource({ word: 'x', contextSentence: 'hello world' });
    expect(s?.rawContext).toBe('hello world');
  });

  it('trims whitespace and drops empty book strings', () => {
    const s = buildKnowledgeSource({ word: 'x', bookTitle: '   ' });
    expect(s?.book).toBeNull();
  });
});

describe('forwardVocabToKnowledgeBase', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('throws KNOWLEDGE_BASE_NOT_CONFIGURED when PAT is empty', async () => {
    vi.stubEnv('KNOWLEDGE_BASE_PAT', '');
    vi.stubEnv('JWT_SECRET', 'test-secret-key-at-least-32-chars!!');
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    const { forwardVocabToKnowledgeBase } = await import(
      '../../../src/services/knowledge-base.service.js'
    );
    await expect(
      forwardVocabToKnowledgeBase({ word: 'x' }, vi.fn() as unknown as typeof fetch)
    ).rejects.toThrow(/not configured/);
  });

  it('POSTs to /api/knowledge/notes with the right shape and returns first entry', async () => {
    vi.stubEnv('KNOWLEDGE_BASE_PAT', 'pat_test');
    vi.stubEnv('KNOWLEDGE_BASE_URL', 'https://kb.example.com');
    vi.stubEnv('JWT_SECRET', 'test-secret-key-at-least-32-chars!!');
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    const { forwardVocabToKnowledgeBase } = await import(
      '../../../src/services/knowledge-base.service.js'
    );

    const mockEntry: KnowledgeBaseEntry = {
      id: 'kb-uuid-1',
      word: 'contextual',
      language: 'english',
      category: 'vocabulary',
      definition: '相关的',
      pronunciation: null,
      partOfSpeech: 'adjective',
      exampleSentence: null,
      labels: [],
      source: { app: 'nibbler', book: 'Pragmatic Programmer', author: null, location: 'page 87', rawContext: null },
      createdAt: '2026-05-16T00:00:00Z',
      updatedAt: '2026-05-16T00:00:00Z',
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ entries: [mockEntry] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await forwardVocabToKnowledgeBase(
      {
        word: 'contextual',
        translation: '相关的',
        bookTitle: 'Pragmatic Programmer',
        page: 87,
      },
      fetchMock as unknown as typeof fetch
    );

    expect(result).toEqual(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://kb.example.com/api/knowledge/notes');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer pat_test');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain('"contextual" means "相关的"');
    expect(body.source).toMatchObject({ app: 'nibbler', book: 'Pragmatic Programmer', location: 'page 87' });
  });

  it('propagates upstream 5xx as 502', async () => {
    vi.stubEnv('KNOWLEDGE_BASE_PAT', 'pat_test');
    vi.stubEnv('JWT_SECRET', 'test-secret-key-at-least-32-chars!!');
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    const { forwardVocabToKnowledgeBase } = await import(
      '../../../src/services/knowledge-base.service.js'
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('upstream broken', { status: 502 }));
    await expect(
      forwardVocabToKnowledgeBase({ word: 'x' }, fetchMock as unknown as typeof fetch)
    ).rejects.toMatchObject({ status: 502 });
  });

  it('propagates upstream 4xx as 400 (caller sent bad data)', async () => {
    vi.stubEnv('KNOWLEDGE_BASE_PAT', 'pat_test');
    vi.stubEnv('JWT_SECRET', 'test-secret-key-at-least-32-chars!!');
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    const { forwardVocabToKnowledgeBase } = await import(
      '../../../src/services/knowledge-base.service.js'
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    await expect(
      forwardVocabToKnowledgeBase({ word: 'x' }, fetchMock as unknown as typeof fetch)
    ).rejects.toMatchObject({ status: 400 });
  });

  it('treats a 2xx with no entries as a successful dedup (returns a synthetic entry, does not throw)', async () => {
    vi.stubEnv('KNOWLEDGE_BASE_PAT', 'pat_test');
    vi.stubEnv('JWT_SECRET', 'test-secret-key-at-least-32-chars!!');
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    const { forwardVocabToKnowledgeBase } = await import(
      '../../../src/services/knowledge-base.service.js'
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ entries: [] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    // A deduped word must NOT throw — throwing made the WordByWord client
    // re-forward the same word on every sync forever. The forwarder returns a
    // best-effort entry built from the input so the caller proceeds to the
    // local insert and clears the dirty flag.
    const result = await forwardVocabToKnowledgeBase(
      { word: 'déjà', translation: 'already', targetLanguage: 'french' },
      fetchMock as unknown as typeof fetch
    );
    expect(result.word).toBe('déjà');
    expect(result.definition).toBe('already');
    expect(result.language).toBe('french');
    expect(result.category).toBe('vocabulary');
  });
});

describe('knowledgeEntryToLegacyVocab', () => {
  const mockEntry: KnowledgeBaseEntry = {
    id: 'kb-1',
    word: 'foo',
    language: 'english',
    category: 'vocabulary',
    definition: 'translated',
    pronunciation: 'fuː',
    partOfSpeech: 'noun',
    exampleSentence: null,
    labels: [],
    source: { app: 'nibbler', book: 'Book', author: null, location: 'page 1', rawContext: null },
    createdAt: '2026-05-16T00:00:00Z',
    updatedAt: '2026-05-16T00:00:00Z',
  };

  it('exposes the knowledge-base id so the frontend can dedupe by it', () => {
    const out = knowledgeEntryToLegacyVocab(mockEntry, { word: 'foo' });
    expect(out.id).toBe('kb-1');
  });

  it('prefers caller-provided values for nibbler-only fields', () => {
    const out = knowledgeEntryToLegacyVocab(mockEntry, {
      word: 'foo',
      translation: 'caller-translation',
      bookTitle: 'Caller Book',
      page: 99,
    });
    expect(out.translation).toBe('caller-translation');
    expect(out.bookTitle).toBe('Caller Book');
    expect(out.page).toBe(99);
  });
});
