import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../../src/lib/config.js', () => ({
  config: { MAX_UPLOAD_SIZE_MB: 1 },
}));

import { uploadBodyLimit, avatarBodyLimit, MAX_AVATAR_SIZE } from '../../../src/middleware/body-limit.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

const MB = 1024 * 1024;

// KAN-404: the routes parsed the whole multipart body with c.req.formData()
// before checking file.size, so the size cap never bounded memory.
function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  const parsed = vi.fn();
  const handler = async (c: any) => {
    const form = await c.req.formData();
    parsed();
    return c.json({ size: (form.get('file') as File).size });
  };
  app.post('/upload', uploadBodyLimit, handler);
  app.post('/avatar', avatarBodyLimit, handler);
  return { app, parsed };
}

function multipart(bytes: number) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], 'a.pdf', { type: 'application/pdf' }));
  form.append('title', 'A Book');
  return new Request('http://x/placeholder', { method: 'POST', body: form });
}

async function post(app: Hono, path: string, bytes: number, chunked: boolean) {
  const base = multipart(bytes);
  const body = await base.arrayBuffer();
  const headers = new Headers({ 'content-type': base.headers.get('content-type')! });
  if (chunked) {
    let sent = false;
    const stream = new ReadableStream({
      pull(ctl) {
        if (sent) return ctl.close();
        sent = true;
        // Hand it over in 64 KB pieces so the counter trips mid-stream.
        const u8 = new Uint8Array(body);
        for (let i = 0; i < u8.length; i += 64 * 1024) ctl.enqueue(u8.slice(i, i + 64 * 1024));
      },
    });
    headers.set('transfer-encoding', 'chunked');
    return app.request(path, { method: 'POST', body: stream, headers, duplex: 'half' } as RequestInit);
  }
  headers.set('content-length', String(body.byteLength));
  return app.request(path, { method: 'POST', body, headers });
}

describe('uploadBodyLimit', () => {
  it('lets an at-the-limit upload through to the handler', async () => {
    const { app, parsed } = makeApp();
    const res = await post(app, '/upload', 1 * MB, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: MB });
    expect(parsed).toHaveBeenCalledOnce();
  });

  it('413s an oversized Content-Length body without parsing it, with the route\'s message', async () => {
    const { app, parsed } = makeApp();
    const res = await post(app, '/upload', 2 * MB, false);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'File size exceeds the 1MB limit' });
    expect(parsed).not.toHaveBeenCalled();
  });

  it('413s an oversized chunked body with the same message', async () => {
    const { app, parsed } = makeApp();
    const res = await post(app, '/upload', 2 * MB, true);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'File size exceeds the 1MB limit' });
    expect(parsed).not.toHaveBeenCalled();
  });
});

describe('avatarBodyLimit', () => {
  it('lets a 2 MB avatar through', async () => {
    const { app } = makeApp();
    const res = await post(app, '/avatar', MAX_AVATAR_SIZE, false);
    expect(res.status).toBe(200);
  });

  it('413s a 3 MB avatar, Content-Length or chunked', async () => {
    for (const chunked of [false, true]) {
      const { app, parsed } = makeApp();
      const res = await post(app, '/avatar', 3 * MB, chunked);
      expect(res.status).toBe(413);
      expect((await res.json()).error.message).toBe('File must be under 2 MB');
      expect(parsed).not.toHaveBeenCalled();
    }
  });
});
