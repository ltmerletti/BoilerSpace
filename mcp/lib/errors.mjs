export class CompanionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
    this.details = details;
  }
}

export const LOGIN_RECOVERY = 'Ask the user to complete sign-in for the affected site. From mcp/, run node cli.mjs login for Brightspace, or node cli.mjs login --site ed, piazza or gradescope for that provider, using the same --data-dir as the MCP server. The user enters credentials in the dedicated browser. Retry the failed read or resume its job after sign-in succeeds. Do not keep searching caches to work around the failed sign-in unless the user chooses offline results.';

export const AGENT_LOGIN_GUIDANCE = 'A quick cached lookup is fine when it directly answers the question; report its freshness. If the answer is missing, uncertain or needs current verification, use the relevant live read or refresh. If a tool or job reports sign-in-required, stop further retrieval and ask the user to sign in instead of digging through other caches, local databases, browser profiles or unrelated public pages. ' + LOGIN_RECOVERY;

export function publicError(error) {
  if (error instanceof CompanionError) return { code: error.code, message: error.message, ...error.details,
    ...(error.code === 'sign-in-required' ? { needsUserLogin: true, nextAction: LOGIN_RECOVERY } : {}) };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { code: 'cancelled', message: 'The operation was cancelled or its time limit was reached.' };
  // Browser and network errors can include request headers or login URLs.
  return { code: 'operation-failed', message: 'The operation failed. Run the status command for connection and indexing state.' };
}
