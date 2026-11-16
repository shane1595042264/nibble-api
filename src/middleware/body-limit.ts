import { bodyLimit } from 'hono/body-limit';
import { config } from '../lib/config.js';

export const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2 MB

// Room for the multipart framing around the file: boundaries, part headers and
// the small title/author/mode fields the upload sends alongside it.
const MULTIPART_OVERHEAD = 64 * 1024;

// The routes' own file.size checks only run after c.req.formData() has read and
// parsed the whole body, which costs ~3x the body size in RSS — a 600 MB POST
// added ~1.8 GB before its 413 (KAN-404). bodyLimit rejects on Content-Length
// before reading anything and counts bytes on chunked bodies, so an oversized
// request is cut off at the cap. The 413 bodies match the in-route checks.
export const uploadBodyLimit = bodyLimit({
  maxSize: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024 + MULTIPART_OVERHEAD,
  onError: (c) => c.json({ error: `File size exceeds the ${config.MAX_UPLOAD_SIZE_MB}MB limit` }, 413),
});

export const avatarBodyLimit = bodyLimit({
  maxSize: MAX_AVATAR_SIZE + MULTIPART_OVERHEAD,
  onError: (c) => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'File must be under 2 MB', status: 413 } }, 413),
});
