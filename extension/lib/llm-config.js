export const isCustomLlm = connection => connection?.provider === 'custom';
export const llmLabel = connection => isCustomLlm(connection) ? 'Your model provider' : 'GenAI Studio';

export function normalizeApiBase(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('Enter an API base URL, such as https://api.openai.com/v1.'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.hostname.includes('*')) throw new Error('Enter one API host, without wildcards.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS, or HTTP with localhost or 127.0.0.1.');
  if (url.username || url.password || url.search || url.hash) throw new Error('The API URL cannot contain credentials, query parameters or a fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return url.href.replace(/\/+$/, '');
}

export function apiPermission(baseUrl) {
  const url = new URL(normalizeApiBase(baseUrl));
  // Browser host permissions cover the host across ports and paths.
  return `${url.protocol}//${url.hostname}/*`;
}

export function customConnection({ baseUrl, key = '', model = '' }) {
  baseUrl = normalizeApiBase(baseUrl);
  key = String(key).trim();
  model = String(model).trim();
  if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('Enter the model ID provided by your API service.');
  if (/\s/.test(key) || [...key].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('The API key cannot contain whitespace or control characters.');
  if (!key && !['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname)) throw new Error('Enter an API key for this service.');
  return { provider: 'custom', baseUrl, key, model, modelChosen: true };
}
