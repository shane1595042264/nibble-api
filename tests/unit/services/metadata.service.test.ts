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

  it('logs the timeout branch so a transient outage leaves a server trace', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const abortErr = new Error('The operation was aborted due to timeout');
    abortErr.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(abortErr);

    await expect(metadataService.lookupGoogleBooks('Dune')).resolves.toBeNull();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[metadata]');
    expect(errorSpy.mock.calls[0][0]).toContain('timed out');
  });

  it('logs a non-timeout failure distinctly from the timeout branch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));

    await expect(metadataService.lookupGoogleBooks('Dune')).resolves.toBeNull();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[metadata]');
    expect(errorSpy.mock.calls[0][0]).toContain('failed');
  });

  it('logs the non-ok HTTP status at the previously-silent early return', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    await expect(metadataService.lookupGoogleBooks('Dune')).resolves.toBeNull();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('[metadata]');
    expect(errorSpy.mock.calls[0][1]).toBe(503);
  });
});
