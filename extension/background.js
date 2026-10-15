import { saveSyllabusEntryHere } from './lib/syllabus-store.js';
import { readXsrf } from './lib/sync.js';
import { snapshotSyllabus } from './lib/syllabus-scan.js';
import { waitForSyllabus } from './lib/syllabus-wait.js';

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

async function readInTab(url, courseId, phase) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const onUpdated = (id) => {
    if (id === tab.id) markScanTab(tab.id);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    // Install lifecycle handling before navigation can redirect or finish loading.
    await chrome.tabs.update(tab.id, { url });
    await markScanTab(tab.id);
    return await waitForSyllabus(async () => {
      try {
        const [shot] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotSyllabus, args: [courseId] });
        return shot?.result ?? null;
      } catch {
        if (!(await chrome.tabs.get(tab.id).catch(() => null))) throw new Error('The syllabus tab was closed before it finished loading.');
        return null;
      }
    }, { phase });
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
    const shot = await readInTab(url, message.courseId, 'links');
    return { hrefs: shot?.hrefs ?? [] };
  }
  if (message.phase === 'page') {
    const url = scanUrl(message.href, origin);
    if (!url) return { text: '' };
    const shot = await readInTab(url, null, 'page');
    return { text: shot.text };
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
  if (message?.type === 'boilerspace-save-syllabus') {
    saveSyllabusEntryHere(message.key, message.courseId, message.entry).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'boilerspace-syllabus') {
    readSyllabusRequest(message).then(sendResponse, (err) => sendResponse({ hrefs: [], text: '', error: err.message }));
    return true;
  }
  if (message?.type !== 'boilerspace-xsrf' || !sender.tab?.id) return false;
  readXsrf(sender.tab.id).then((token) => sendResponse({ token }));
  return true;
});
