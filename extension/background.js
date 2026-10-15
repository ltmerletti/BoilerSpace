import { readXsrf } from './lib/sync.js';
import { snapshotSyllabus } from './lib/syllabus-scan.js';

const LINK_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 25_000;
const PAGE_MIN_WAIT_MS = 8_000;
const PAGE_STABLE_MS = 1_200;
const PAGE_MIN_CHARS = 600;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scanUrl(href, origin) {
  const url = new URL(href, origin);
  if (url.origin !== origin) return null;
  url.hash = 'boilerspace-scan';
  return url.href;
}

async function markScanTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    injectImmediately: true,
    func: () => {
      try {
        sessionStorage.setItem('boilerspace-scan', '1');
      } catch {
        // the tab can still be read
      }
    },
  }).catch(() => {});
}

async function pollSnapshot(tabId, courseId, timeoutMs, accept) {
  const started = Date.now();
  let best = { hrefs: [], text: '' };
  let stableSince = 0;
  while (Date.now() - started < timeoutMs) {
    let shot = null;
    try {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId }, func: snapshotSyllabus, args: [courseId] });
      shot = injected?.result ?? null;
    } catch {
      shot = null;
    }
    if (shot) {
      if ((shot.text?.length ?? 0) > best.text.length) {
        best = shot;
        stableSince = Date.now();
      } else if (shot.text === best.text) {
        if (!stableSince) stableSince = Date.now();
      }
      if (accept(shot, best, Date.now() - started, stableSince ? Date.now() - stableSince : 0)) return shot.text?.length >= best.text.length ? shot : best;
    }
    await wait(400);
  }
  return best;
}

async function readInTab(url, courseId, timeoutMs, accept) {
  const tab = await chrome.tabs.create({ url, active: false });
  const onUpdated = (id) => {
    if (id === tab.id) markScanTab(tab.id);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    await markScanTab(tab.id);
    return await pollSnapshot(tab.id, courseId, timeoutMs, accept);
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function readSyllabusRequest(message) {
  const origin = message.origin || 'https://purdue.brightspace.com';
  if (message.phase === 'links') {
    const url = scanUrl(`/d2l/home/${message.courseId}`, origin);
    if (!url) return { hrefs: [] };
    const shot = await readInTab(url, message.courseId, LINK_TIMEOUT_MS, (shot) => shot.hrefs?.length > 0);
    return { hrefs: shot?.hrefs ?? [] };
  }
  if (message.phase === 'page') {
    const url = scanUrl(message.href, origin);
    if (!url) return { text: '' };
    const shot = await readInTab(url, null, PAGE_TIMEOUT_MS, (shot, _best, elapsed, stable) =>
      (shot.text?.length ?? 0) >= PAGE_MIN_CHARS && stable >= PAGE_STABLE_MS && elapsed >= PAGE_MIN_WAIT_MS,
    );
    const text = shot?.text ?? '';
    return { text: text.length >= PAGE_MIN_CHARS ? text : '' };
  }
  return { hrefs: [], text: '' };
}

// Chrome opens the side panel from the toolbar button. Firefox and Zen use a sidebar instead.
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (globalThis.browser?.sidebarAction) {
  chrome.action.onClicked.addListener(() => browser.sidebarAction.toggle());
}

// Content scripts cannot call the page's own XSRF helper, so they ask for it here.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'boilerspace-syllabus') {
    readSyllabusRequest(message).then(sendResponse, (err) => sendResponse({ hrefs: [], text: '', error: err.message }));
    return true;
  }
  if (message?.type !== 'boilerspace-xsrf' || !sender.tab?.id) return false;
  readXsrf(sender.tab.id).then((token) => sendResponse({ token }));
  return true;
});
