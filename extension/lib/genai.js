// Purdue GenAI Studio (Open WebUI 0.11) connection: account linking and rate-limited model requests.

import * as store from './store.js';

export const GENAI_BASE = 'https://genai.rcac.purdue.edu';
export const DEFAULT_MODEL = 'qwen3.8:27b';
export const FALLBACK_MODEL = 'gpt-oss:120b';

const REQUEST_TIMEOUT_MS = 180_000;
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

// Connections made before the default changed move to the new default unless the student picked a model.
export async function getConnection() {
  const connection = await store.get(store.KEYS.genai);
  if (!connection || connection.modelChosen || connection.model === DEFAULT_MODEL) return connection;
  if (connection.models && !connection.models.includes(DEFAULT_MODEL)) return connection;
  const next = { ...connection, model: DEFAULT_MODEL };
  await store.set(store.KEYS.genai, next);
  return next;
}

const isChatModel = (id) => !/embed|arena|whisper|tts|rerank/i.test(id);

async function fetchModelIds(key) {
  const res = await fetch(`${GENAI_BASE}/api/models`, { headers: { Authorization: `Bearer ${key}` }, credentials: 'omit' });
  if (res.status === 401) throw new GenAIError('GenAI Studio rejected the saved key. Connect your account again.', { status: 401, code: 'not-linked' });
  if (!res.ok) throw new GenAIError(`GenAI Studio could not list models (HTTP ${res.status}).`, { status: res.status });
  return ((await res.json()).data ?? []).map((m) => m.id).filter(isChatModel).sort();
}

export async function refreshModels() {
  const connection = await getConnection();
  if (!connection?.key) return [];
  const models = await fetchModelIds(connection.key);
  await store.set(store.KEYS.genai, { ...connection, models });
  return models;
}

export async function setModel(model) {
  const connection = await getConnection();
  if (!connection) return;
  await store.set(store.KEYS.genai, { ...connection, model, modelChosen: model !== DEFAULT_MODEL });
}

export async function unlink() {
  await store.remove(store.KEYS.genai);
}

// ---------- Linking ----------

// Only used if the extension's requests don't carry the site's sign-in cookie. Never stored.
let sessionToken = null;

function webui(path, { method = 'GET' } = {}) {
  return fetch(GENAI_BASE + path, {
    method,
    credentials: 'include',
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
  const tab = await chrome.tabs.create({ url: `${GENAI_BASE}/auth` });
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
  try {
    onStatus('Checking your GenAI Studio sign-in…');
    const user = (await whoami()) ?? (await signInViaTab(onStatus));
    if (!user) throw new GenAIError('GenAI Studio sign-in was not completed.');

    onStatus(`Signed in as ${user.name}. Getting your API key…`);
    const { key, created } = await getOrCreateKey();

    const ids = await fetchModelIds(key).catch((err) => {
      throw new GenAIError(`The API key did not work (${err.message}).`);
    });
    const model = ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : ids[0] ?? null;
    if (!model) throw new GenAIError('No chat models are available to your GenAI Studio account.');

    const connection = { key, model, models: ids, name: user.name, created, linkedAt: new Date().toISOString() };
    await store.set(store.KEYS.genai, connection);
    return connection;
  } finally {
    sessionToken = null;
  }
}

// ---------- Requests ----------

let queue = Promise.resolve();
let lastRequestAt = 0;

function schedule(task) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.catch(() => {});
  return run;
}

// Reads an OpenAI-style event stream into one message. onDelta(content, reasoning) gets the text so far;
// reasoning arrives as reasoning_content (or reasoning) depending on the backend.
export async function readEventStream(body, onDelta = () => {}, { idleMs = STREAM_IDLE_MS } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const calls = [];
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new GenAIError(chunk.error.message ?? String(chunk.error));
    const delta = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message ?? {};
    const thought = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
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
  for (;;) {
    let timer;
    const idle = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new GenAIError('GenAI Studio stopped responding. Try again, or pick a smaller model in Settings.')), idleMs);
    });
    let result;
    try {
      result = await Promise.race([reader.read(), idle]);
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const { value, done } = result;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
    }
  }
  handle(buffer.trim());
  const message = { role: 'assistant', content, ...(reasoning ? { reasoning } : {}) };
  const toolCalls = calls.filter((c) => c?.function.name).map((c, i) => ({ ...c, id: c.id ?? `call_${i}` }));
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

// onDelta streams the answer text; signal lets the student stop a request.
export async function chatCompletion(body, { onDelta = null, signal = null } = {}) {
  const connection = await getConnection();
  if (!connection?.key) throw new GenAIError('Connect Purdue GenAI Studio first.', { code: 'not-linked' });
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  for (let attempt = 0; ; attempt++) {
    const res = await schedule(() =>
      fetch(`${GENAI_BASE}/api/chat/completions`, {
        method: 'POST',
        credentials: 'omit',
        headers: { Authorization: `Bearer ${connection.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: connection.model ?? DEFAULT_MODEL, ...body, ...(onDelta ? { stream: true } : {}) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }),
    );
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after')) || 4 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (res.status === 401) throw new GenAIError('GenAI Studio rejected the saved key. Connect your account again.', { status: 401, code: 'not-linked' });
    if (!res.ok) throw new GenAIError(`GenAI Studio request failed (HTTP ${res.status}).`, { status: res.status });
    if (onDelta && (res.headers.get('content-type') ?? '').includes('event-stream')) return readEventStream(res.body, onDelta);
    const json = await res.json();
    const message = json.choices?.[0]?.message;
    if (!message) throw new GenAIError('GenAI Studio returned no message.');
    const reasoning = message.reasoning_content ?? message.reasoning;
    return reasoning ? { ...message, reasoning } : message;
  }
}
