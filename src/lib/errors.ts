export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (msg = 'Invalid or expired token') =>
    new AppError('UNAUTHORIZED', msg, 401),
  forbidden: (msg = 'Insufficient permissions') =>
    new AppError('FORBIDDEN', msg, 403),
  notFound: (resource: string) =>
    new AppError('NOT_FOUND', `${resource} not found`, 404),
  conflict: (msg: string) =>
    new AppError('CONFLICT', msg, 409),
  duplicateBook: () =>
    new AppError('DUPLICATE_BOOK', 'Book already in your library', 409),
  paymentRequired: () =>
    new AppError('PAYMENT_REQUIRED', 'Processing job not yet paid', 402),
  processingFailed: (msg: string) =>
    new AppError('PROCESSING_FAILED', msg, 500),
  aiError: (msg: string) =>
    new AppError('AI_ERROR', msg, 502),
  rateLimited: () =>
    new AppError('RATE_LIMITED', 'Too many requests', 429),
  badRequest: (msg: string) =>
    new AppError('BAD_REQUEST', msg, 400),
  storageReclaimFailed: (msg = 'Storage reclaim failed; the hourly cleanup job will retry') =>
    new AppError('STORAGE_RECLAIM_FAILED', msg, 502),
};

/**
 * Copy for the 409 raised when idx_processing_jobs_active_file_hash — a partial
 * unique index on file_hash ALONE, not user-scoped — is already held by an
 * in-flight job for the same content-addressed file.
 *
 * Two audiences need two sentences. The retry path has a Retry button to point
 * the user back at; an uploader has none and has to pick the file again, so
 * telling them "Retry will work" points at a button that isn't on screen
 * (KAN-322). The upload copy is deliberately impersonal — the colliding job may
 * belong to a different account, and that must not leak.
 */
export const ACTIVE_JOB_CONFLICT = 'This file is already being processed — it will finish shortly, then Retry will work';
export const ACTIVE_JOB_UPLOAD_CONFLICT = 'This file is already being processed — it will finish shortly. Please try uploading it again in a few minutes.';

/**
 * True when `err` — or anything on its cause chain — carries the given SQLSTATE.
 *
 * Drizzle wraps every driver rejection in a DrizzleQueryError whose own `code`
 * is undefined and hangs the real PostgresError (the one carrying SQLSTATE) off
 * `.cause`. A top-level `err.code` check therefore never matches a real query
 * failure, so every caller silently fell through to an opaque 500 (KAN-302).
 */
function hasSqlState(err: unknown, sqlState: string): boolean {
  let current: unknown = err;
  // Bounded so a self-referential cause chain can't spin.
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === sqlState) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True when a driver error is a Postgres foreign-key violation (SQLSTATE 23503).
 * Lets a handler turn an FK restrict/no-action rejection into an actionable 4xx
 * instead of letting it fall through the global handler as an opaque 500.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasSqlState(err, '23503');
}

/**
 * True when a driver error is a Postgres unique-violation (SQLSTATE 23505).
 * idx_books_user_catalog spans soft-deleted rows too, so any handler that
 * inserts a books row can lose a race with a concurrent insert; mapping the
 * code to a real 409 keeps that from surfacing as an opaque 500.
 */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, '23505');
}
