import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { metadataService } from '../../../src/services/metadata.service.js';

type FetchInit = Parameters<typeof fetch>[1];

describe('metadata.service Google Books lookup', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('passes an AbortSignal to the Google Books fetch (bounds the upload path)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ volumeInfo: { title: 'Dune' } }] }),
    });

    const result = await metadataService.lookupGoogleBooks('Dune');
    expect(result?.title).toBe('Dune');

    const init = fetchMock.mock.calls[0][1] as FetchInit;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null on a timeout (AbortError) instead of hanging or throwing', async () => {
    const abortErr = new Error('The operation was aborted due to timeout');
    abortErr.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(abortErr);

    // The catch { return null } must swallow the abort so handleUpload can fall
    // back to manual metadata and the upload still completes.
    await expect(metadataService.lookupGoogleBooks('Dune')).resolves.toBeNull();
  });
});
