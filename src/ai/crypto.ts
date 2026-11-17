// Readers' AI keys are stored sealed, AES-256-GCM (as in shaneBackend SHAN-596).
//
// The data key is derived from JWT_SECRET with HKDF under its own label, so no
// new secret has to be provisioned on Railway and the two uses can never be
// confused for each other. The price: rotating JWT_SECRET (shared with
// WordByWord's /api/auth/token) makes every stored AI key unreadable. Nothing
// breaks loudly; openKey() throws, the key is marked failing, and Settings asks
// the reader to add it again.
//
// Layout: base64( iv[12] | tag[16] | ciphertext ).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../lib/config.js';

const VERSION_LABEL = 'nibbler/user-ai-keys/v1';

function dataKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', config.JWT_SECRET, 'nibbler', VERSION_LABEL, 32));
}

export function sealKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openKey(sealed: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', dataKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
