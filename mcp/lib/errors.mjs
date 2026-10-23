export class CompanionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
    this.details = details;
  }
}

export function publicError(error) {
  if (error instanceof CompanionError) return { code: error.code, message: error.message, ...error.details };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { code: 'cancelled', message: 'The operation was cancelled or its time limit was reached.' };
  // Browser and network errors can include request headers or login URLs.
  return { code: 'operation-failed', message: 'The operation failed. Run the status command for connection and indexing state.' };
}
