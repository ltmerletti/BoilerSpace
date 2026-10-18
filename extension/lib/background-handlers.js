import { GRADESCOPE_SITES } from './gradescope.js';
import { handleGradescopeRequest } from './gradescope-sync.js';
import { clearDiscussionAuth } from './discussion-auth.js';
import { reportSyllabusAccess, SYLLABUS_SITE } from './syllabus-access.js';
import { saveSyllabusEntryHere } from './syllabus-store.js';
import { chooseSyllabusHere, clearLocalDataHere, saveChatsHere } from './data-lifecycle.js';
import { handleGenaiDataRequest } from './genai-store.js';
import { readXsrf } from './sync.js';
import { snapshotSyllabus } from './syllabus-scan.js';
import { waitForSyllabus } from './syllabus-wait.js';
import { handleDiscussionRequest } from './discussions-sync.js';
import { DISCUSSION_SITES, parseDiscussionUrl } from './discussions.js';

function scanUrl(href, origin) {
  const url = new URL(href, origin);
  if (url.origin !== origin) return null;
  url.hash = 'boilerspace-scan';
  return url.href;
}

const BRIGHTSPACE_ORIGIN = 'https://purdue.brightspace.com';

function isBrightspaceSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id) return false;
  try {
    const url = new URL(sender.url);
    return url.origin === BRIGHTSPACE_ORIGIN && url.pathname.startsWith('/d2l/');
  } catch {
    return false;
  }
}

function isPanelSender(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
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
  const origin = BRIGHTSPACE_ORIGIN;
  if (message.origin && message.origin !== origin) throw new Error('Unexpected syllabus site.');
  if (message.phase === 'links') {
    if (!Number.isSafeInteger(message.courseId) || message.courseId <= 0) throw new Error('Invalid syllabus course.');
    const url = scanUrl(`/d2l/home/${message.courseId}`, origin);
    if (!url) return { hrefs: [] };
    const shot = await readInTab(url, message.courseId, 'links');
    return { hrefs: shot?.hrefs ?? [] };
  }
  if (message.phase === 'page') {
    const launch = new URL(message.href, origin);
    if (launch.origin !== origin || !launch.pathname.startsWith('/d2l/')) throw new Error('Unexpected syllabus page.');
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

// Content scripts cannot call the page's own XSRF helper, so they ask for it here.
export function handleMessage(message, sender, sendResponse) {
  // Only our panel can mutate extension data. Brightspace content scripts also
  // need the rendered syllabus reader and the page's XSRF helper.
  const fromPanel = isPanelSender(sender);
  const fromBrightspace = isBrightspaceSender(sender);
  if (!fromPanel && !(fromBrightspace && ['boilerspace-syllabus', 'boilerspace-syllabus-access', 'boilerspace-xsrf'].includes(message?.type))) return false;
  if (message?.type === 'boilerspace-data') {
    const run = message.action === 'clear' ? clearLocalDataHere()
      : message.action === 'save-chats' ? saveChatsHere(message.chats, message.epoch)
      : message.action === 'syllabus-choice' ? chooseSyllabusHere(message.courseId, message.choice, message.epoch)
      : message.action?.startsWith('genai-') ? handleGenaiDataRequest(message)
      : Promise.reject(new Error('Unknown local data operation.'));
    run.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message, code: error.code }));
    return true;
  }
  if (message?.type === 'boilerspace-gradescope') {
    const run = message.action === 'open-access'
      ? chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html?gradescope-access=1'), active: true }).then(() => null)
      : handleGradescopeRequest(message);
    run.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message, needsReconnect: Boolean(error.needsReconnect) }));
    return true;
  }
  if (message?.type === 'boilerspace-discussions') {
    const run = async () => {
      if (message.action !== 'open-access') return handleDiscussionRequest(message);
      if (!DISCUSSION_SITES[message.platform]) throw new Error('Unknown discussion site.');
      const params = new URLSearchParams({ 'discussions-access': message.platform });
      if (message.platform === 'piazza' && message.url) params.set('course', parseDiscussionUrl(message.url).url);
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
    saveSyllabusEntryHere(message.key, message.courseId, message.entry, message.epoch).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }
  if (message?.type === 'boilerspace-syllabus') {
    sharedSyllabusRequest(message).then(sendResponse, (err) => sendResponse({ hrefs: [], text: '', error: err.message }));
    return true;
  }
  if (message?.type !== 'boilerspace-xsrf' || !fromBrightspace) return false;
  readXsrf(sender.tab.id).then((token) => sendResponse({ token }), () => sendResponse({ token: null }));
  return true;
}

export const onSiteAccessChanged = ({ origins }) => {
  if (origins?.some(origin => GRADESCOPE_SITES.includes(origin))) {
    chrome.permissions.contains({ origins: GRADESCOPE_SITES }).then(async allowed => {
      if (allowed) return;
      const { gradescope } = await chrome.storage.local.get('gradescope');
      if (gradescope) await chrome.storage.local.set({ gradescope: { ...gradescope, status: 'error', needsReconnect: true, error: 'Allow Gradescope access to reconnect.' } });
    }).catch(() => {});
  }
  if (origins?.some(origin => DISCUSSION_SITES.ed.includes(origin))) {
    chrome.permissions.contains({ origins: DISCUSSION_SITES.ed }).then(allowed => {
      if (!allowed) return clearDiscussionAuth('ed');
    }).catch(() => {});
  }
  if (origins?.includes(SYLLABUS_SITE)) reportSyllabusAccess().catch(() => {});
};
