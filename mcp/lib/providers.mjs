import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { CookieJar, Cookie } from 'tough-cookie';
import { BrightspaceSession } from './session.mjs';
import { privateDirectory } from './config.mjs';
import { CompanionError } from './errors.mjs';
import { piazzaCsrf } from '../../extension/lib/discussion-auth.js';
import { parseGradescopeCourses } from '../../extension/lib/gradescope.js';

export const SITES = {
  ed: { origin: 'https://us.edstem.org', login: 'https://edstem.org/us/dashboard', cookies: ['https://edstem.org', 'https://us.edstem.org'] },
  piazza: { origin: 'https://piazza.com', login: 'https://piazza.com/', cookies: ['https://piazza.com'] },
  gradescope: { origin: 'https://www.gradescope.com', login: 'https://www.gradescope.com/account', cookies: ['https://www.gradescope.com'] },
};

export function providerRequest(site, value, options = {}) {
  const url = new URL(value);
  const method = options.method ?? 'GET';
  let allowed = false;
  if (site === 'ed' && url.origin === SITES.ed.origin) allowed = method === 'GET' && (/^\/api\/(?:user|courses\/\d+\/threads|threads\/\d+)$/.test(url.pathname)) || method === 'POST' && url.pathname === '/api/renew_token' && !options.body;
  if (site === 'gradescope' && url.origin === SITES.gradescope.origin) allowed = method === 'GET' && /^\/(?:account|courses\/\d+)\/?$/.test(url.pathname);
  if (site === 'piazza' && url.origin === SITES.piazza.origin) {
    allowed = method === 'GET' && /^\/(?:class(?:\/[a-z0-9]+)?\/?)?$/i.test(url.pathname);
    if (method === 'POST' && url.pathname === '/logic/api') {
      let body;
      try { body = JSON.parse(options.body); } catch { /* Rejected below. */ }
      const expected = { 'user.status': [], 'network.get_my_feed': ['nid', 'limit', 'offset', 'sort'], 'content.get': ['nid', 'cid', 'student_view'] };
      allowed = body && Object.hasOwn(expected, body.method) && url.searchParams.get('method') === body.method
        && body.params && Object.keys(body.params).every(key => expected[body.method].includes(key))
        && Object.keys(body).every(key => ['method', 'params'].includes(key));
    }
  }
  if (!allowed || url.username || url.password || url.hash) throw new CompanionError('blocked-request', 'This request is outside the connected site’s read-only reader.');
  return url;
}

export class ProviderSession extends BrightspaceSession {
  constructor(directory, site, options = {}) {
    if (!SITES[site]) throw new CompanionError('unknown-site', 'Choose ed, piazza or gradescope.');
    super(path.join(directory, 'providers', site), { ...options, origin: SITES[site].origin });
    this.site = site;
  }
  async login({ executablePath, timeout = 300000, onStatus = () => {}, launch = chromium.launchPersistentContext.bind(chromium), verificationRequest } = {}) {
    await privateDirectory(this.directory);
    const context = await launch(await privateDirectory(path.join(this.directory, 'login-profile')), { headless: false, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const request = verificationRequest ?? context.request;
      await page.goto(SITES[this.site].login, { waitUntil: 'domcontentloaded', timeout: 60000 });
      onStatus(`Sign into ${this.site} in the separate browser. It closes after verification.`);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new CompanionError('sign-in-cancelled', 'The sign-in window was closed.');
        let identity;
        try {
          if (this.site === 'ed') {
            this.token = await page.evaluate(() => localStorage.getItem('authToken:us') || localStorage.getItem('authToken'));
            if (this.token) {
              const response = await request.get(`${this.origin}/api/user`, { headers: { 'x-token': this.token }, maxRedirects: 0 });
              if (response.ok()) { const data = await response.json(); identity = data.user?.id ?? data.id ?? data.user_id; }
            }
          } else if (this.site === 'piazza') {
            if (new URL(page.url()).origin !== this.origin) throw new Error('Still signing in');
            const html = await page.content();
            const csrf = piazzaCsrf(html);
            const response = await request.post(`${this.origin}/logic/api?method=user.status`, { headers: { 'csrf-token': csrf }, data: { method: 'user.status', params: {} }, maxRedirects: 0 });
            const data = await response.json();
            if (!data.error) identity = data.result?.id ?? data.result?.user?.id ?? data.result?.user_id ?? data.result?.uid ?? data.result?.email;
          } else {
            const response = await request.get(`${this.origin}/account`, { maxRedirects: 0 });
            if (response.ok()) {
              const html = await response.text(); parseGradescopeCourses(html);
              identity = /(?:gon\.(?:user_id|current_user_id)|["'](?:user_id|current_user_id)["'])\s*(?:=|:)\s*["']?(\d+)/.exec(html)?.[1];
              identity ??= await page.evaluate(() => window.gon?.page_context?.user_trn ?? window.gon?.page_context?.gainsight_user_info?.id ?? window.gon?.page_context?.user_id ?? window.gon?.page_context?.user?.id ?? window.gon?.page_context?.current_user?.id);
              identity ??= await page.locator('[data-user-id]').first().getAttribute('data-user-id', { timeout: 500 }).catch(() => null);
            }
          }
        } catch { /* The user may still be on the sign-in page. */ }
        if (identity !== undefined && identity !== null) {
          this.accountKey = createHash('sha256').update(`${this.origin}:${identity}`).digest('hex');
          this.jar = new CookieJar();
          for (const cookie of await context.cookies(SITES[this.site].cookies)) await this.jar.setCookie(new Cookie({ key: cookie.name, value: cookie.value,
            domain: cookie.domain.replace(/^\./, ''), path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
            hostOnly: !cookie.domain.startsWith('.'), ...(cookie.expires > 0 ? { expires: new Date(cookie.expires * 1000) } : {}) }), `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`);
          this.generation = randomUUID();
          await this.save({ login: true });
          return { connected: true, site: this.site };
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new CompanionError('sign-in-timeout', `Could not verify ${this.site} sign-in within five minutes.`);
    } finally { await context.close(); }
  }
  async fetch(value, options = {}, signal, redirects = 0) {
    const url = providerRequest(this.site, value, options);
    await this.load();
    const generation = this.generation;
    const headers = { ...options.headers, ...(this.site === 'ed' ? { 'x-token': this.token } : { Cookie: await this.jar.getCookieString(url.href) }) };
    const response = await this.fetchImpl(url.href, { ...options, headers, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]) });
    const retainCookies = async () => {
      await this.load();
      if (generation !== this.generation) throw new CompanionError('sign-in-changed', 'The site connection changed during the request.');
      for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url.href);
      await this.save();
    };
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      await retainCookies();
      const next = new URL(response.headers.get('location') ?? '/', url);
      if (this.site === 'piazza' && next.origin === this.origin && (options.method ?? 'GET') === 'GET' && redirects < 4) return this.fetch(providerRequest(this.site, next.href).href, options, signal, redirects + 1);
      throw Object.assign(new CompanionError('sign-in-required', `Run login --site ${this.site} to renew the connection.`), { needsReconnect: true });
    }
    const chunks = [], reader = response.body?.getReader(); let length = 0;
    try {
      if (reader) for (;;) {
        const { done, value: bytes } = await reader.read(); if (done) break;
        if ((length += bytes.length) > 16_000_000) throw new CompanionError('response-too-large', 'The site response exceeded the 16 MB reader limit.');
        chunks.push(bytes);
      }
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    await retainCookies();
    return new Response([204, 205].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, headers: response.headers });
  }
  async edToken(force = false, signal) {
    await this.load();
    const expiry = (() => { try { return JSON.parse(Buffer.from(this.token.split('.')[1], 'base64url')).exp * 1000; } catch { return 0; } })();
    if (force || expiry && expiry - Date.now() < 3 * 86400000) {
      const response = await this.fetch(`${this.origin}/api/renew_token`, { method: 'POST' }, signal);
      if (response.ok) { const data = await response.json(); if (typeof data.token === 'string' && data.token) { this.token = data.token; await this.save(); } }
    }
    return this.token;
  }
}
