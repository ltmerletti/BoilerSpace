import { readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CookieJar, Cookie } from 'tough-cookie';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { createClient, fileByteLimit } from '../../extension/lib/brightspace.js';
import { ORIGIN, MAX_FILE_BYTES, allowedPath, atomicJson, privateDirectory } from './config.mjs';
import { CompanionError } from './errors.mjs';

const credentialWriters = new Map();

async function accountBinding(directory) {
  try {
    const binding = JSON.parse(await readFile(path.join(directory, 'account.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(binding.key)) throw new Error('Invalid account binding');
    return binding;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new CompanionError('account-binding-unreadable', 'The account binding could not be read. Use a new --data-dir rather than mixing this cache with another account.');
  }
}

// Serialize the generation check and file replacement across CLI/MCP processes.
// SQLite releases this lock on a crash; no stale lock-file removal is needed.
async function credentialWrite(directory, write) {
  const previous = credentialWriters.get(directory) ?? Promise.resolve();
  let release;
  const queued = new Promise(resolve => { release = resolve; });
  credentialWriters.set(directory, queued);
  await previous;
  let lock;
  try {
    const file = path.join(directory, 'session-lock.sqlite');
    if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new CompanionError('unsafe-directory', 'The session lock cannot be a symbolic link.');
    lock = new DatabaseSync(file);
    lock.exec('PRAGMA busy_timeout=5000; PRAGMA user_version=1; BEGIN IMMEDIATE');
    return await write();
  } finally {
    lock?.close();
    release();
    if (credentialWriters.get(directory) === queued) credentialWriters.delete(directory);
  }
}

export class BrightspaceSession {
  constructor(directory, { fetchImpl = fetch, now = () => Date.now(), responseByteLimit = MAX_FILE_BYTES } = {}) {
    this.directory = directory; this.file = path.join(directory, 'session.json');
    this.fetchImpl = fetchImpl; this.now = now; this.jar = null; this.loading = null;
    this.responseByteLimit = responseByteLimit;
  }
  async load() {
    const modified = await lstat(this.file).then(stat => `${stat.ino}:${stat.mtimeMs}:${stat.size}`).catch(() => null);
    if (this.jar && modified !== null && modified === this.modified) return;
    this.loading ??= (async () => {
      let stored;
      try {
        const stat = await lstat(this.file);
        if (stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('Unsafe session file');
        stored = JSON.parse(await readFile(this.file, 'utf8'));
      } catch { throw new CompanionError('sign-in-required', 'Run boilerspace-companion login to sign into Purdue in the separate browser.'); }
      if (stored.origin !== ORIGIN) throw new CompanionError('sign-in-required', 'The saved connection is not a Purdue Brightspace session. Sign in again.');
      const binding = await accountBinding(this.directory);
      if (binding && binding.key !== stored.accountKey) throw new CompanionError('sign-in-required', 'This session does not match the data directory. Sign into its original Purdue account again.');
      this.jar = await CookieJar.deserialize(stored.cookies);
      this.xsrf = stored.xsrf ?? null;
      this.accountKey = stored.accountKey;
      this.generation = stored.generation;
      this.modified = modified;
    })();
    try { await this.loading; } finally { this.loading = null; }
  }
  async save({ login = false } = {}) {
    await credentialWrite(this.directory, async () => {
      if (login && this.accountKey) {
        const accountFile = path.join(this.directory, 'account.json');
        const binding = await accountBinding(this.directory);
        if (binding && binding.key !== this.accountKey) throw new CompanionError('different-account', 'This data directory belongs to another Purdue account. Use a different --data-dir for this account.');
        if (!binding) await atomicJson(accountFile, { key: this.accountKey });
      }
      if (!login) {
        const current = await readFile(this.file, 'utf8').then(JSON.parse).catch(() => null);
        if (current?.generation !== this.generation) return;
      }
      await atomicJson(this.file, { origin: ORIGIN, cookies: await this.jar.serialize(), xsrf: this.xsrf, accountKey: this.accountKey, generation: this.generation, savedAt: new Date(this.now()).toISOString() });
      const stat = await lstat(this.file);
      this.modified = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    });
  }

  async login({ timeout = 300_000, executablePath, onStatus = () => {}, launch = chromium.launchPersistentContext.bind(chromium) } = {}) {
    await privateDirectory(this.directory);
    const profile = await privateDirectory(path.join(this.directory, 'login-profile'));
    const context = await launch(profile, { headless: false, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`${ORIGIN}/d2l/home`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      onStatus('Sign into Purdue in the separate browser window. This window closes after the connection is verified.');
      const deadline = this.now() + timeout;
      while (this.now() < deadline) {
        if (page.isClosed()) throw new CompanionError('sign-in-cancelled', 'The sign-in window was closed. Run login to try again.');
        if (page.url().startsWith(`${ORIGIN}/d2l/`) && !page.url().includes('/d2l/login')) {
          const xsrf = await page.evaluate(() => window.D2L?.LP?.Web?.Authentication?.Xsrf?.GetXsrfToken?.() ?? null).catch(() => null);
          // Some Purdue API routes require the same bearer minting used by its
          // web components even after the browser is visibly signed in.
          const verification = createClient({ origin: ORIGIN, xsrfToken: xsrf, fetchImpl: async (url, options = {}) => {
            allowedPath(url);
            const response = await page.evaluate(async ({ url, options }) => {
              const response = await fetch(url, { method: options.method ?? 'GET', headers: options.headers, body: options.body, credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(15000) });
              return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
            }, { url, options: { method: options.method, headers: options.headers, body: options.body } });
            return new Response(response.body, { status: response.status, headers: response.headers });
          } });
          const identifier = await verification.getJson('/d2l/api/lp/1.62/users/whoami').then(value => value && ['string', 'number'].includes(typeof value.Identifier) ? String(value.Identifier) : null).catch(() => null);
          if (identifier) {
            this.accountKey = createHash('sha256').update(`${ORIGIN}:${identifier}`).digest('hex');
            this.jar = new CookieJar();
            for (const cookie of await context.cookies(ORIGIN)) {
              const value = new Cookie({ key: cookie.name, value: cookie.value, domain: cookie.domain.replace(/^\./, ''), path: cookie.path,
                secure: cookie.secure, httpOnly: cookie.httpOnly, hostOnly: !cookie.domain.startsWith('.'), ...(cookie.expires > 0 ? { expires: new Date(cookie.expires * 1000) } : {}) });
              await this.jar.setCookie(value, ORIGIN);
            }
            this.xsrf = xsrf;
            this.generation = randomUUID();
            await this.save({ login: true });
            return { connected: true, origin: ORIGIN };
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new CompanionError('sign-in-timeout', 'Sign-in did not finish within five minutes. Run login to try again.');
    } catch (error) {
      this.jar = null; this.modified = null;
      throw error;
    } finally { await context.close(); }
  }

  async logout() {
    await credentialWrite(this.directory, async () => {
      this.jar = null; this.xsrf = null;
      await rm(this.file, { force: true });
      await rm(path.join(this.directory, 'login-profile'), { recursive: true, force: true });
    });
    return { connected: false, cachedMaterialKept: true };
  }

  async client(signal = null) {
    await this.load();
    const generation = this.generation;
    let requests = 0;
    const client = createClient({ origin: ORIGIN, xsrfToken: this.xsrf, fetchImpl: async (value, options = {}) => {
      await this.load();
      if (this.generation !== generation) throw new CompanionError('sign-in-changed', 'The saved sign-in changed. Resume this job to use the new connection.');
      const url = allowedPath(value);
      if (++requests > 1000) throw new CompanionError('request-budget', 'This operation exceeded its 1,000-request budget.');
      const method = options.method ?? 'GET';
      if (method !== 'GET' && !(method === 'POST' && url.pathname === '/d2l/lp/auth/oauth2/token')) throw new CompanionError('blocked-request', 'The companion does not submit coursework or change Brightspace data.');
      const cookie = await this.jar.getCookieString(url.href);
      const combined = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]);
      let response;
      for (let attempt = 0; ; attempt++) {
        combined.throwIfAborted();
        response = await this.fetchImpl(url.href, { ...options, headers: { ...options.headers, Cookie: cookie }, signal: combined, redirect: 'manual' });
        if (![429, 502, 503, 504].includes(response.status) || attempt >= 2) break;
        await response.body?.cancel();
        const retry = Math.min(5000, Math.max(500, Number(response.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt));
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { combined.removeEventListener('abort', abort); resolve(); }, retry);
          const abort = () => { clearTimeout(timer); reject(combined.reason); };
          combined.addEventListener('abort', abort, { once: true });
          if (combined.aborted) abort();
        });
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new CompanionError('sign-in-required', 'Brightspace redirected the request. Run login again; no redirect was followed with your credentials.');
      }
      for (const header of response.headers.getSetCookie()) await this.jar.setCookie(header, url.href);
      const fileRequest = /\/file$|^\/content\//.test(url.pathname);
      if (response.ok && !fileRequest && /text\/html/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new CompanionError('sign-in-required', 'Brightspace returned a web page instead of API data. Check the connection with login if other requests fail too.'); }
      let limit = Math.min(this.responseByteLimit, fileRequest ? MAX_FILE_BYTES : 8_000_000);
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new CompanionError('file-too-large', `The response exceeds the ${limit / 1_000_000} MB limit.`); }
      const reader = response.body?.getReader();
      const chunks = [];
      const prefix = [];
      let size = 0;
      try {
        if (reader) for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          if (fileRequest && prefix.length < 2) {
            prefix.push(...chunk.subarray(0, 2 - prefix.length));
            if (prefix.length === 2) limit = Math.min(limit, fileByteLimit(prefix));
          }
          if (Number(response.headers.get('content-length')) > limit) throw new CompanionError('file-too-large', `The response exceeds the ${limit / 1_000_000} MB limit.`);
          if ((size += chunk.byteLength) > limit) throw new CompanionError('file-too-large', `The response exceeds the ${limit / 1_000_000} MB limit.`);
          chunks.push(chunk);
        }
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    } });
    for (const method of ['getJson', 'getAll', 'getText', 'getFile']) {
      const request = client[method];
      client[method] = async (...args) => {
        try { return await request(...args); }
        catch (error) {
          if (error.status === 401) throw new CompanionError('sign-in-required', 'Your Purdue session expired. Run login again. Previously indexed material is still available.');
          throw error;
        }
      };
    }
    return client;
  }
}
