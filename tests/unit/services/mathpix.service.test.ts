import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/lib/config.js', () => ({
  config: { MATHPIX_APP_ID: 'test-id', MATHPIX_APP_KEY: 'test-key' },
}));

import { mathpixService } from '../../../src/services/mathpix.service.js';

type FetchInit = Parameters<typeof fetch>[1];

describe('mathpix.service timeouts', () => {
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

  it('convertImageToLatex passes an AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ latex_simplified: 'x^2' }),
    });
    const result = await mathpixService.convertImageToLatex(Buffer.from('img'));
    expect(result).toBe('x^2');
    const init = fetchMock.mock.calls[0][1] as FetchInit;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('convertPageToMarkdown passes an AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'page md' }),
    });
    const result = await mathpixService.convertPageToMarkdown(Buffer.from('img'));
    expect(result).toBe('page md');
    const init = fetchMock.mock.calls[0][1] as FetchInit;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('convertPdfToMarkdown passes an AbortSignal to every fetch (upload, status, both downloads)', async () => {
    fetchMock
      // Step 1: upload
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_id: 'abc' }) })
      // Step 2: status (one attempt, completed)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'completed' }) })
      // Step 3: lines.json
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pages: [{ page: 1, lines: [{ text: 'hello' }] }] }) })
      // Step 3: .md
      .mockResolvedValueOnce({ ok: true, text: async () => 'hello world' });

    await mathpixService.convertPdfToMarkdown(Buffer.from('%PDF-1.4'));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as FetchInit;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('polling loop survives a TimeoutError on one attempt and completes on the next', async () => {
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';

    fetchMock
      // upload
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_id: 'abc' }) })
      // status attempt 1: throws TimeoutError (per-attempt abort fires)
      .mockRejectedValueOnce(timeoutErr)
      // status attempt 2: completed
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'completed' }) })
      // downloads
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pages: [{ page: 1, lines: [{ text: 'hi' }] }] }) })
      .mockResolvedValueOnce({ ok: true, text: async () => 'hi there' });

    // Make setTimeout (the 2s sleep between polls) resolve immediately so the
    // test doesn't actually wait 2 seconds. Note: AbortSignal.timeout is not
    // exercised here — the timeout is simulated by the mocked rejection above.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      const pages = await mathpixService.convertPdfToMarkdown(Buffer.from('%PDF-1.4'));
      expect(pages).toEqual(['hi there']);
    } finally {
      setTimeoutSpy.mockRestore();
    }

    // Sanity: confirm both status attempts ran (upload + 2 status + 2 downloads = 5)
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('polling loop still throws on a non-timeout error (HTTP failure)', async () => {
    fetchMock
      // upload
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_id: 'abc' }) })
      // status attempt 1: non-ok HTTP — must NOT be swallowed
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      await expect(mathpixService.convertPdfToMarkdown(Buffer.from('%PDF-1.4')))
        .rejects.toThrow(/Mathpix status error 500/);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('polling loop still throws on a Mathpix processing-error response', async () => {
    fetchMock
      // upload
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pdf_id: 'abc' }) })
      // status attempt 1: processing failed — must NOT be swallowed
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'error', error: 'bad pdf' }) });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      await expect(mathpixService.convertPdfToMarkdown(Buffer.from('%PDF-1.4')))
        .rejects.toThrow(/Mathpix processing error: bad pdf/);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
