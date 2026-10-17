import { reportSyllabusAccess, SYLLABUS_SITE } from './lib/syllabus-access.js';
import { saveSyllabusEntryHere } from './lib/syllabus-store.js';
import { readXsrf } from './lib/sync.js';
import { snapshotSyllabus } from './lib/syllabus-scan.js';
import { waitForSyllabus } from './lib/syllabus-wait.js';
import { handleDiscussionRequest } from './lib/discussions-sync.js';
import { DISCUSSION_SITES, parseDiscussionUrl } from './lib/discussions.js';

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
        const shots = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: phase === 'page' }, func: snapshotSyllabus, args: [courseId] });
        return shots.map((shot) => shot.result).filter(Boolean).sort((a, b) => Number(b.contentReady) - Number(a.contentReady) || Number(b.notFound) - Number(a.notFound) || (b.text?.length ?? 0) - (a.text?.length ?? 0))[0] ?? null;
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
    const launch = new URL(message.href, origin);
    if (launch.searchParams.get('type') === 'lti' && !(await reportSyllabusAccess())) {
      throw new Error('BoilerSpace needs access to purdue.simplesyllabus.com to read this syllabus. Use Allow Simple Syllabus access in BoilerSpace.');
    }
    const url = scanUrl(message.href, origin);
    if (!url) return { text: '' };
    const shot = await readInTab(url, null, 'page');
    return { text: shot.text, notFound: shot.notFound === true };
  }
  return { hrefs: [], text: '' };
}

// A sidebar and an embedded panel can request the same page at the same time.
const scans = new Map();
function sharedSyllabusRequest(message) {
  const key = JSON.stringify([message.origin, message.phase, message.courseId, message.href]);
  if (scans.has(key)) return scans.get(key);
  const pending = readSyllabusRequest(message).finally(() => scans.delete(key));
  scans.set(key, pending);
  return pending;
}

// Chrome opens the side panel from the toolbar button. Firefox and Zen use a sidebar instead.
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (globalThis.browser?.sidebarAction) {
  chrome.action.onClicked.addListener(() => browser.sidebarAction.toggle());
}

// Content scripts cannot call the page's own XSRF helper, so they ask for it here.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'boilerspace-discussions') {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    const run = async () => {
      if (message.action !== 'open-access') return handleDiscussionRequest(message);
      if (!DISCUSSION_SITES[message.platform]) throw new Error('Unknown discussion site.');
      const params = new URLSearchParams({ 'discussions-access': message.platform });
      if (message.platform === 'piazza') params.set('course', parseDiscussionUrl(message.url).url);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`sidepanel.html?${params}`), active: true });
      return null;
    };
    run().then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'boilerspace-open-syllabus-access') {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html?syllabus-access=1'), active: true }).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'boilerspace-syllabus-access') {
    reportSyllabusAccess().then((granted) => sendResponse({ ok: true, granted }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'boilerspace-save-syllabus') {
    saveSyllabusEntryHere(message.key, message.courseId, message.entry).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'boilerspace-syllabus') {
    sharedSyllabusRequest(message).then(sendResponse, (err) => sendResponse({ hrefs: [], text: '', error: err.message }));
    return true;
  }
  if (message?.type !== 'boilerspace-xsrf' || !sender.tab?.id) return false;
  readXsrf(sender.tab.id).then((token) => sendResponse({ token }));
  return true;
});

const onSiteAccessChanged = ({ origins }) => {
  if (origins?.includes(SYLLABUS_SITE)) reportSyllabusAccess().catch(() => {});
};
chrome.permissions.onAdded?.addListener(onSiteAccessChanged);
chrome.permissions.onRemoved?.addListener(onSiteAccessChanged);
