// Purdue GenAI Studio (Open WebUI 0.11) connection: account linking and rate-limited model requests.

import { dataRequest } from './data-lifecycle.js';

export const GENAI_BASE = 'https://genai.rcac.purdue.edu';
export const DEFAULT_MODEL = 'qwen3.8:27b';
export const FALLBACK_MODEL = 'gpt-oss:120b';

const REQUEST_TIMEOUT_MS = 180_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const STREAM_IDLE_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const SIGN_IN_POLL_MS = 2000;
// GenAI Studio allows 20 requests per minute per user.
const MIN_REQUEST_SPACING_MS = 3100;
const MAX_RATE_LIMIT_RETRIES = 3;

export class GenAIError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'GenAIError';
    this.status = status;
    this.code = code;
  }
}

export async function getConnection() {
  return dataRequest('genai-read');
}

const isChatModel = (id) => !/embed|arena|whisper|tts|rerank/i.test(id);

async function fetchModelIds(key) {
  const res = await fetch(`${GENAI_BASE}/api/models`, { headers: { Authorization: `Bearer ${key}` }, credentials: 'omit', signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS) });
  if (res.status === 401) throw new GenAIError('GenAI Studio rejected the saved key. Connect your account again.', { status: 401, code: 'not-linked' });
  if (!res.ok) throw new GenAIError(`GenAI Studio could not list models (HTTP ${res.status}).`, { status: res.status });
  return ((await res.json()).data ?? []).map((m) => m.id).filter(isChatModel).sort();
}

export async function refreshModels() {
  const { connection, epoch, identity } = await dataRequest('genai-refresh-begin');
  if (!connection?.key) return [];
  const models = await fetchModelIds(connection.key);
  return dataRequest('genai-refresh', { epoch, identity, models });
}

export async function setModel(model) {
  await dataRequest('genai-set-model', { model });
}

export async function unlink() {
  await dataRequest('genai-unlink');
}

// ---------- Linking ----------

// Only used if the extension's requests don't carry the site's sign-in cookie. Never stored.
let sessionToken = null;

function webui(path, { method = 'GET' } = {}) {
  return fetch(GENAI_BASE + path, {
    method,
    credentials: 'include',
    signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
  });
}

async function whoami() {
  const res = await webui('/api/v1/auths/').catch(() => null);
  return res?.ok ? res.json() : null;
}

async function readSessionToken(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => localStorage.getItem('token') });
    return result?.result ?? null;
  } catch {
    return null;
  }
}

async function signInViaTab(onStatus) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await chrome.tabs.update(tab.id, { url: `${GENAI_BASE}/auth` });
  onStatus('Sign in to GenAI Studio with your Purdue account in the new tab. BoilerSpace continues on its own.');
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SIGN_IN_POLL_MS));
    if (!(await chrome.tabs.get(tab.id).catch(() => null))) return null;
    let user = await whoami();
    if (!user) {
      const token = await readSessionToken(tab.id);
      if (token) {
        sessionToken = token;
        user = await whoami();
      }
    }
    if (user) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      return user;
    }
  }
  return null;
}

async function getOrCreateKey() {
  const existing = await webui('/api/v1/auths/api_key');
  if (existing.ok) return { key: (await existing.json()).api_key, created: false };
  if (existing.status !== 404) throw new GenAIError(`GenAI Studio refused access to your API key (HTTP ${existing.status}).`);

  // Only reached when the account has no key. Each account has one key, and creating one replaces it.
  const created = await webui('/api/v1/auths/api_key', { method: 'POST' });
  if (!created.ok) throw new GenAIError(`GenAI Studio could not create an API key (HTTP ${created.status}).`);
  return { key: (await created.json()).api_key, created: true };
}

export async function linkAccount({ onStatus = () => {} } = {}) {
  const attempt = await dataRequest('genai-link-begin');
  try {
    onStatus('Checking your GenAI Studio sign-in…');
    const user = (await whoami()) ?? (await signInViaTab(onStatus));
    if (!user) throw new GenAIError('GenAI Studio sign-in was not completed.');

    await dataRequest('genai-link-check', attempt);
    onStatus('Connecting to Purdue GenAI Studio…');
    const { key, created } = await getOrCreateKey();

    const ids = await fetchModelIds(key).catch((err) => {
      throw new GenAIError(`The API key did not work (${err.message}).`);
    });
    const model = ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : ids[0] ?? null;
    if (!model) throw new GenAIError('No chat models are available to your GenAI Studio account.');

    const connection = { key, model, models: ids, name: user.name, created, linkedAt: new Date().toISOString() };
    return await dataRequest('genai-link-finish', { ...attempt, connection });
  } finally {
    sessionToken = null;
    await dataRequest('genai-link-cancel', attempt).catch(() => {});
  }
}

// ---------- Requests ----------

let queue = Promise.resolve();
let lastRequestAt = 0;

function withSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => { signal.removeEventListener('abort', abort); settle(value); };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}

function waitForRequest(ms, signal) {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function schedule(task, signal) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
    await waitForRequest(wait, signal);
    signal?.throwIfAborted();
    lastRequestAt = Date.now();
    return withSignal(task(), signal);
  });
  queue = run.catch(() => {});
  return withSignal(run, signal);
}

// Reads an OpenAI-style event stream into one message. onDelta(content, reasoning) gets the text so far;
// reasoning arrives as reasoning_content (or reasoning) depending on the backend.
export async function readEventStream(body, onDelta = () => {}, { idleMs = STREAM_IDLE_MS, signal = null } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finished = false;
  let lastProgressAt = Date.now();
  const calls = [];
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { finished = true; return; }
    if (!data) return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new GenAIError(chunk.error.message ?? String(chunk.error));
    const delta = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message ?? {};
    const thought = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (thought || delta.content || delta.tool_calls?.length) lastProgressAt = Date.now();
    if (thought) reasoning += thought;
    if (delta.content) content += delta.content;
    if (thought || delta.content) onDelta(content, reasoning);
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? calls.length;
      calls[index] ??= { id: null, type: 'function', function: { name: '', arguments: '' } };
      if (call.id) calls[index].id = call.id;
      if (call.function?.name && !calls[index].function.name) calls[index].function.name = call.function.name;
      if (call.function?.arguments) calls[index].function.arguments += call.function.arguments;
    }
  };
  try {
    while (!finished) {
      signal?.throwIfAborted();
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new GenAIError('GenAI Studio stopped responding. Try again, or pick a smaller model in Settings.', { code: 'stream-idle' })), Math.max(0, lastProgressAt + idleMs - Date.now()));
      });
      let result;
      try {
        result = await withSignal(Promise.race([reader.read(), idle]), signal);
      } finally {
        clearTimeout(timer);
      }
      const { value, done } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    }
    if (!finished) handle(buffer.trim());
    const message = { role: 'assistant', content, ...(reasoning ? { reasoning } : {}) };
    const toolCalls = calls.filter((c) => c?.function.name).map((c, i) => ({ ...c, id: c.id ?? `call_${i}` }));
    if (toolCalls.length) message.tool_calls = toolCalls;
    return message;
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// onDelta streams the answer text; signal lets the student stop a request.
export async function chatCompletion(body, { onDelta = null, signal = null } = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const connection = await withSignal(getConnection(), requestSignal);
    if (!connection?.key) throw new GenAIError('Connect Purdue GenAI Studio first.', { code: 'not-linked' });
    for (let attempt = 0; ; attempt++) {
      const res = await schedule(() =>
        fetch(`${GENAI_BASE}/api/chat/completions`, {
          method: 'POST',
          credentials: 'omit',
          headers: { Authorization: `Bearer ${connection.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: connection.model ?? DEFAULT_MODEL, ...body, ...(onDelta ? { stream: true } : {}) }),
          signal: requestSignal,
        }),
        requestSignal,
      );
      // Purdue's gateway also reports an explicit rate limit as HTTP 400.
      try {
        const problem = res.status === 400 ? await withSignal(res.json(), requestSignal).catch(error => {
          requestSignal.throwIfAborted();
          if (error instanceof SyntaxError) return null;
          throw error;
        }) : null;
        const detail = problem?.detail ?? problem?.error?.message ?? problem?.message;
        const rateLimited = res.status === 429 || (res.status === 400 && typeof detail === 'string' && /\brate limit (?:exceeded|reached)\b|\btoo many requests\b/i.test(detail));
        if (rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
          const header = res.headers.get('retry-after');
          const retryMs = header && (/^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now());
          await waitForRequest(retryMs > 0 ? retryMs : 15_000 * 2 ** attempt, requestSignal);
          continue;
        }
        if (rateLimited) throw new GenAIError('GenAI Studio’s request limit was reached. Wait a minute and try again.', { status: res.status, code: 'rate-limited' });
        if (res.status === 401) throw new GenAIError('GenAI Studio rejected the saved key. Connect your account again.', { status: 401, code: 'not-linked' });
        if (!res.ok) throw new GenAIError(`GenAI Studio request failed (HTTP ${res.status}).`, { status: res.status });
        if (onDelta && (res.headers.get('content-type') ?? '').includes('event-stream')) return await readEventStream(res.body, onDelta, { signal: requestSignal });
        const json = await withSignal(res.json(), requestSignal);
        const message = json.choices?.[0]?.message;
        if (!message) throw new GenAIError('GenAI Studio returned no message.');
        const reasoning = message.reasoning_content ?? message.reasoning;
        return reasoning ? { ...message, reasoning } : message;
      } finally {
        res.body?.cancel().catch(() => {});
      }
    }
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new GenAIError('GenAI Studio took too long to respond. Try again, or choose another model in Settings.', { code: 'request-timeout' });
    throw error;
  }
}
