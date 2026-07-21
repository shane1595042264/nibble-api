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
};
