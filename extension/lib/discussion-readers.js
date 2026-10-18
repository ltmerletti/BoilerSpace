import { DISCUSSION_SITES } from './discussions.js';

const REGISTRY = 'discussionReaders';
const ALARM = 'boilerspace-discussion-readers';
const LEASE_MS = 5 * 60_000;
let operations = Promise.resolve();
const serial = work => {
  const result = operations.catch(() => {}).then(work);
  operations = result;
  return result;
};
const readRegistry = async () => (await chrome.storage.session.get(REGISTRY))[REGISTRY] ?? {};
const writeRegistry = async registry => {
  await chrome.storage.session.set({ [REGISTRY]: registry });
  const expires = Object.values(registry).map(entry => entry.expiresAt);
  if (expires.length) await chrome.alarms.create(ALARM, { when: Math.min(...expires) });
  else await chrome.alarms.clear(ALARM);
};
export const discussionReaderKey = (platform, remoteId) => platform === 'ed' ? 'ed' : `piazza:${remoteId ?? 'discover'}`;
const hasMarker = (entry, tab) => tab?.url === entry.url || tab?.pendingUrl === entry.url;
const readerUrl = (entry, url) => {
  if (url === entry.url) return true;
  try {
    const saved = new URL(entry.url), current = new URL(url);
    // Piazza clears unknown hashes after loading. Keep the same owned page;
    // activation or navigation to a different page still relinquishes it.
    return (saved.hash === current.hash || (saved.hash.startsWith('#boilerspace-reader=') && !current.hash))
      && saved.origin === current.origin && saved.pathname === current.pathname && saved.search === current.search;
  } catch { return false; }
};
const openingUrl = (entry, url) => {
  try { return entry.opening && new URL(url).origin === new URL(entry.url).origin; }
  catch { return false; }
};
const stagingTab = (entry, tab) => entry.staging && entry.tabId === tab.id
  && (!tab.url || tab.url === 'about:blank') && (!tab.pendingUrl || tab.pendingUrl === 'about:blank');
const owns = (entry, tab) => {
  if (!tab || tab.active) return false;
  const identified = stagingTab(entry, tab) || hasMarker(entry, tab)
    || (entry.tabId === tab.id && (readerUrl(entry, tab.url) || readerUrl(entry, tab.pendingUrl) || openingUrl(entry, tab.url)));
  return identified
    && (!tab.pendingUrl || readerUrl(entry, tab.pendingUrl) || openingUrl(entry, tab.pendingUrl))
    && (!tab.url || tab.url === 'about:blank' || readerUrl(entry, tab.url) || openingUrl(entry, tab.url));
};

async function findOwned(entry) {
  // IDs are trusted only within the browser session that created the tab. Once
  // navigation starts, its URL also has to match the recorded reader identity.
  const tab = entry.tabId === undefined
    ? (await chrome.tabs.query({})).find(tab => hasMarker(entry, tab))
    : await chrome.tabs.get(entry.tabId).catch(() => null);
  return owns(entry, tab) ? tab : null;
}
async function closeOwned(entry) {
  const tab = await findOwned(entry);
  if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
}
const matches = (platform, remoteId, discover, tab) => {
  try {
    const url = new URL(tab.url);
    return url.protocol === 'https:' && (platform === 'ed'
      ? ['edstem.org', 'us.edstem.org'].includes(url.hostname)
      : url.hostname === 'piazza.com' && (remoteId ? url.pathname.replace(/\/+$/, '') === `/class/${remoteId}` : discover));
  } catch { return false; }
};

export async function acquireDiscussionReader(platform, { remoteId, discover, generation }) {
  const origins = DISCUSSION_SITES[platform];
  if (!origins || !(await chrome.permissions.contains({ origins }))) throw new Error(`Allow ${platform === 'ed' ? 'Ed' : 'Piazza'} access by connecting it in Settings.`);
  return serial(async () => {
    const registry = await readRegistry();
    const key = discussionReaderKey(platform, remoteId);
    const previous = registry[key];
    if (previous) {
      const tab = await findOwned(previous);
      if (tab && previous.generation === generation && previous.expiresAt > Date.now()) {
        previous.tabId = tab.id;
        previous.expiresAt = Date.now() + LEASE_MS;
        await writeRegistry(registry);
        if (stagingTab(previous, tab)) await chrome.tabs.update(tab.id, { url: previous.url });
        return { tab, key, owned: true };
      }
      if (tab) await closeOwned(previous);
      delete registry[key];
      await writeRegistry(registry);
    }
    const ownedIds = new Set(Object.values(registry).map(entry => entry.tabId));
    const tabs = await chrome.tabs.query({ url: origins });
    const tab = tabs.filter(tab => !ownedIds.has(tab.id) && matches(platform, remoteId, discover, tab))
      .sort((a, b) => Number(b.active ?? false) - Number(a.active ?? false) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (tab) return { tab, key, owned: false };
    const marker = `#boilerspace-reader=${crypto.randomUUID()}`;
    const entry = { generation, opening: true, staging: true,
      url: (platform === 'ed' ? 'https://edstem.org/us/dashboard' : remoteId ? `https://piazza.com/class/${remoteId}` : 'https://piazza.com/') + marker,
      expiresAt: Date.now() + LEASE_MS };
    registry[key] = entry;
    await writeRegistry(registry);
    try {
      // Stage navigation so lifecycle observers attach before the site loads.
      const created = await chrome.tabs.create({ url: 'about:blank', active: false });
      entry.tabId = created.id;
      await writeRegistry(registry);
      // Activation/navigation may race creation. A user who takes over keeps it.
      if (!await findOwned(entry)) throw new Error('The discussion reader tab was opened or changed. Retry the import.');
      await chrome.tabs.update(created.id, { url: entry.url });
      return { tab: created, key, owned: true };
    } catch (error) {
      await closeOwned(entry);
      delete registry[key];
      await writeRegistry(registry);
      throw error;
    }
  });
}

export const settleDiscussionReader = (key, tabId) => serial(async () => {
  const registry = await readRegistry();
  const entry = registry[key];
  if (!entry || entry.tabId !== tabId) return;
  const tab = await findOwned(entry);
  if (!tab) { delete registry[key]; }
  else {
    // Record the result of the initial site redirect. Later URL changes relinquish
    // ownership, so a user navigating the reader cannot lose their new page.
    entry.url = tab.url;
    entry.opening = false;
    entry.staging = false;
  }
  await writeRegistry(registry);
});

export const releaseDiscussionReader = key => serial(async () => {
  const registry = await readRegistry();
  if (registry[key]) await closeOwned(registry[key]);
  delete registry[key];
  await writeRegistry(registry);
});

export const retainDiscussionReaders = (keys, generation) => serial(async () => {
  const registry = await readRegistry();
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.generation === generation && keys.includes(key)) continue;
    await closeOwned(entry);
    delete registry[key];
  }
  await writeRegistry(registry);
});

export const checkDiscussionReaderTab = (tabId, activated = false) => serial(async () => {
  const registry = await readRegistry();
  let changed = false;
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.tabId !== tabId) continue;
    if (activated || !await findOwned(entry)) { delete registry[key]; changed = true; }
  }
  if (changed) await writeRegistry(registry);
});

export const sweepDiscussionReaders = () => serial(async () => {
  const registry = await readRegistry();
  const data = (await chrome.storage.local.get('discussions')).discussions;
  for (const [key, entry] of Object.entries(registry)) {
    const tab = await findOwned(entry);
    const sourceExists = data?.sources?.some(source => discussionReaderKey(source.platform, source.remoteId) === key);
    if (tab && entry.expiresAt > Date.now() && entry.generation === data?.generation && sourceExists) continue;
    if (tab) await closeOwned(entry);
    delete registry[key];
  }
  await writeRegistry(registry);
});

export function registerDiscussionReaderLifecycle() {
  chrome.tabs.onActivated?.addListener(({ tabId }) => { checkDiscussionReaderTab(tabId, true).catch(() => {}); });
  chrome.tabs.onUpdated?.addListener((tabId, change) => { if (change.url) checkDiscussionReaderTab(tabId).catch(() => {}); });
  chrome.tabs.onRemoved?.addListener(tabId => { checkDiscussionReaderTab(tabId, true).catch(() => {}); });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) sweepDiscussionReaders().catch(() => {}); });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.discussions && (!changes.discussions.newValue
      || changes.discussions.oldValue?.generation !== changes.discussions.newValue.generation)) sweepDiscussionReaders().catch(() => {});
  });
  sweepDiscussionReaders().catch(() => {});
}
