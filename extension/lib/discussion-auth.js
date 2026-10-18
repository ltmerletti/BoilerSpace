import { DISCUSSION_SITES } from './discussions.js';

const AUTH_KEY = 'discussionAuth';
const DAY_MS = 24 * 60 * 60_000;
export const reconnectMessage = platform => `Sign into ${platform === 'ed' ? 'Ed' : 'Piazza'} and reconnect in Settings. Your saved posts are kept.`;
export const discussionAuthError = platform => Object.assign(new Error(reconnectMessage(platform)), { needsReconnect: true });

export async function clearDiscussionAuth(platform, rejectedToken) {
  if (platform && platform !== 'ed') return;
  const current = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY];
  if (rejectedToken && current?.ed !== rejectedToken) return;
  await chrome.storage.local.remove(AUTH_KEY);
  await chrome.storage.session.remove(AUTH_KEY);
}

async function savedEdAuth() {
  let auth = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY];
  if (!auth?.ed) {
    const previous = (await chrome.storage.session.get(AUTH_KEY))[AUTH_KEY];
    if (typeof previous?.ed === 'string' && previous.ed) {
      auth = { ed: previous.ed };
      await chrome.storage.local.set({ [AUTH_KEY]: auth });
      await chrome.storage.session.remove(AUTH_KEY);
    }
  }
  return auth;
}

export async function edSessionToken(preferPage = false, rejectedToken) {
  const saved = await savedEdAuth();
  if (preferPage || !saved?.ed || rejectedToken) {
    // Reuse an already-open page when needed. Never create or navigate a tab.
    const tabs = await chrome.tabs.query({ url: DISCUSSION_SITES.ed });
    const candidates = tabs.filter(tab => /^https:\/\/(?:us\.)?edstem\.org\//.test(tab.url ?? ''))
      .sort((a, b) => Number(b.active ?? false) - Number(a.active ?? false) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    for (const tab of candidates) {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () =>
        localStorage.getItem('authToken:us') || localStorage.getItem('authToken')
      }).catch(() => []);
      const token = result?.result;
      if (typeof token === 'string' && token && token !== rejectedToken) {
        await chrome.storage.local.set({ [AUTH_KEY]: { ed: token } });
        return token;
      }
    }
  }
  if (typeof saved?.ed === 'string' && saved.ed && saved.ed !== rejectedToken) return saved.ed;
  throw discussionAuthError('ed');
}

function expiresAt(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

export async function renewEdSessionToken(token, force = false) {
  const auth = await savedEdAuth();
  if (auth?.ed !== token) return token;
  const now = Date.now(), expiry = expiresAt(token);
  const due = !auth.renewedAt || now - auth.renewedAt >= DAY_MS || (expiry && expiry - now < 3 * DAY_MS);
  if (!force && (!due || now - (auth.lastRenewAttemptAt ?? 0) < 60 * 60_000)) return token;
  await chrome.storage.local.set({ [AUTH_KEY]: { ...auth, lastRenewAttemptAt: now } });
  try {
    // Ed's own client renews through this endpoint after restoring a saved login.
    const response = await fetch('https://us.edstem.org/api/renew_token', {
      method: 'POST', credentials: 'omit', headers: { 'x-token': token }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return token;
    const result = await response.json();
    if (typeof result.token !== 'string' || !result.token) return token;
    const current = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY];
    if (current?.ed !== token) return token; // Do not restore a disconnected or replaced credential.
    await chrome.storage.local.set({ [AUTH_KEY]: { ed: result.token, renewedAt: now, lastRenewAttemptAt: now } });
    return result.token;
  } catch {
    // A renewal outage must not discard a credential that still works.
    return token;
  }
}

// The CSRF token is read as data; no scripts from the fetched page are executed.
export function piazzaCsrf(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare]));
    if (attributes.name === 'csrf_token' && attributes.content) return attributes.content.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  }
  throw discussionAuthError('piazza');
}
