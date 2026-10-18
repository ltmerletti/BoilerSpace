import { DISCUSSION_SITES } from './discussions.js';

const SESSION_KEY = 'discussionAuth';
export const reconnectMessage = platform => `Sign into ${platform === 'ed' ? 'Ed' : 'Piazza'} and reconnect in Settings. Your saved posts are kept.`;

export async function clearDiscussionAuth(platform) {
  if (!platform || platform === 'ed') await chrome.storage.session.remove(SESSION_KEY);
}

export async function edSessionToken(connect = false) {
  const saved = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]?.ed;
  if (connect) {
    // Only a user-initiated connection reads credentials from an existing page.
    // Routine sync never opens, navigates, injects into, or closes a site tab.
    const tabs = await chrome.tabs.query({ url: DISCUSSION_SITES.ed });
    const candidates = tabs.filter(tab => /^https:\/\/(?:us\.)?edstem\.org\//.test(tab.url ?? ''))
      .sort((a, b) => Number(b.active ?? false) - Number(a.active ?? false) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    for (const tab of candidates) {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () =>
        localStorage.getItem('authToken:us') || localStorage.getItem('authToken')
      }).catch(() => []);
      if (typeof result?.result === 'string' && result.result) {
        await chrome.storage.session.set({ [SESSION_KEY]: { ed: result.result } });
        return result.result;
      }
    }
  }
  if (typeof saved === 'string' && saved) return saved;
  throw new Error(reconnectMessage('ed'));
}

// The CSRF token is read as data; no scripts from the fetched page are executed.
export function piazzaCsrf(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare]));
    if (attributes.name === 'csrf_token' && attributes.content) return attributes.content.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  }
  throw new Error(reconnectMessage('piazza'));
}
