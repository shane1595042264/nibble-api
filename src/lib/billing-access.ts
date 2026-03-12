import { config } from './config.js';

/**
 * Check if a user gets free AI access (bypasses Stripe).
 * True if: admin OR email is in the FREE_AI_EMAILS whitelist.
 */
export function hasFreeAiAccess(user: { email: string; authRole: string }): boolean {
  if (user.authRole === 'admin') return true;

  const freeEmails = config.FREE_AI_EMAILS
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  return freeEmails.includes(user.email.toLowerCase());
}
