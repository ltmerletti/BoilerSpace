// Extension-side entry points. The work itself runs in content.js inside a signed-in Brightspace tab.

import * as store from './store.js';
import { lockIsFresh } from './sync-store.js';

export { isSyncDue, AUTO_SYNC_INTERVAL_MS } from './sync-store.js';

export const BRIGHTSPACE_ORIGIN = 'https://purdue.brightspace.com';

const TAB_LOAD_TIMEOUT_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const SIGN_IN_POLL_MS = 1500;

const isSignedInUrl = (url) => Boolean(url?.startsWith(`${BRIGHTSPACE_ORIGIN}/d2l/`)) && !url.includes('/d2l/login');

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, TAB_LOAD_TIMEOUT_MS);
    function done() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export async function findBrightspaceTab({ open = true, onStatus = () => {} } = {}) {
  const tabs = await chrome.tabs.query({ url: `${BRIGHTSPACE_ORIGIN}/d2l/*` });
  const ready = tabs.find((t) => t.status === 'complete' && isSignedInUrl(t.url)) ?? tabs.find((t) => isSignedInUrl(t.url));
  if (ready) return ready;
  if (!open) return null;

  onStatus('Opening Brightspace…');
  const created = await chrome.tabs.create({ url: `${BRIGHTSPACE_ORIGIN}/d2l/home`, active: false });
  await waitForTabLoad(created.id);
  let tab = await chrome.tabs.get(created.id).catch(() => null);
  if (tab && isSignedInUrl(tab.url)) return tab;

  await chrome.tabs.update(created.id, { active: true }).catch(() => {});
  onStatus('Sign in to Brightspace in the new tab. BoilerSpace continues on its own.');
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SIGN_IN_POLL_MS));
    tab = await chrome.tabs.get(created.id).catch(() => null);
    if (!tab) return null;
    if (tab.status === 'complete' && isSignedInUrl(tab.url)) return tab;
  }
  return null;
}

export async function readXsrf(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          return window.D2L?.LP?.Web?.Authentication?.Xsrf?.GetXsrfToken?.() ?? null;
        } catch {
          return null;
        }
      },
    });
    return result?.result ?? null;
  } catch {
    return null;
  }
}

// Tabs opened before the extension was installed or reloaded have no content script yet.
async function ensureContentScript(tabId) {
  const pong = await chrome.tabs.sendMessage(tabId, { type: 'boilerspace-ping' }, { frameId: 0 }).catch(() => null);
  if (pong?.ok) return;
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
}

async function askTab(tabId, message) {
  await ensureContentScript(tabId);
  const xsrfToken = await readXsrf(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { ...message, xsrfToken }, { frameId: 0 });
  if (!response) throw new Error('The Brightspace tab did not answer. Reload it and try again.');
  if (!response.ok) throw Object.assign(new Error(response.error), { status: response.status, path: response.path });
  return response;
}

// When the panel is shown inside a Brightspace page, it asks that page directly instead of going through tabs,
// which Firefox does not offer to extension frames embedded in websites.
let pageBridge = null;

export function connectParentPage() {
  const pending = new Map();
  window.addEventListener('message', (event) => {
    if (event.origin !== BRIGHTSPACE_ORIGIN || event.source !== window.parent || typeof event.data !== 'string') return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data?.type !== 'boilerspace-response' || !pending.has(data.id)) return;
    pending.get(data.id)(data);
    pending.delete(data.id);
  });
  pageBridge = (action, args = {}) =>
    new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pending.set(id, (response) => {
        if (!response.ok) reject(Object.assign(new Error(response.error), { status: response.status, path: response.path }));
        else resolve(response);
      });
      window.parent.postMessage(JSON.stringify({ type: 'boilerspace-request', id, action, args }), BRIGHTSPACE_ORIGIN);
    });
}

export const canReachBrightspace = async () => Boolean(pageBridge) || Boolean(await findBrightspaceTab({ open: false }));

export async function syncNow({ tabId = null, onStatus = () => {} } = {}) {
  if (lockIsFresh(await store.get(store.KEYS.syncLock))) return { ok: true, skipped: true };
  if (pageBridge) return pageBridge('sync');
  const tab = tabId ? { id: tabId } : await findBrightspaceTab({ onStatus });
  if (!tab) throw new Error('Brightspace sign-in was not completed.');
  return askTab(tab.id, { type: 'boilerspace-sync' });
}

async function requestDownload(path, { open, onStatus, seeImages = false, location = null }) {
  const args = { path, seeImages: Boolean(seeImages), location };
  if (pageBridge) return pageBridge('download', args);
  const tab = await findBrightspaceTab({ open, onStatus });
  if (!tab) throw new Error('Open Brightspace to read course files.');
  return askTab(tab.id, { type: 'boilerspace-download', ...args });
}

export async function readQuizOnPage(quiz, { open = true, onStatus = () => {} } = {}) {
  const args = { courseId: quiz.courseId, quizId: quiz.id, dueAt: quiz.dueAt ?? null, endAt: quiz.endAt ?? null };
  if (pageBridge) {
    const { result } = await pageBridge('read-quiz', args);
    return result;
  }
  const tab = await findBrightspaceTab({ open, onStatus });
  if (!tab) throw new Error('Open Brightspace to read this quiz.');
  const { result } = await askTab(tab.id, { type: 'boilerspace-read-quiz', ...args });
  return result;
}

export async function downloadTopicFile(path, { open = true, onStatus = () => {}, seeImages = false, location = null } = {}) {
  const { result } = await requestDownload(path, { open, onStatus, seeImages, location });
  if (Array.isArray(result.pages)) {
    return {
      kind: result.kind,
      pages: result.pages,
      warning: result.warning ?? null,
      contentType: result.contentType ?? '',
      fileName: result.fileName ?? null,
      ...(result.images ? { images: result.images } : {}),
    };
  }
  const binary = atob(result.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, contentType: result.contentType, fileName: result.fileName };
}
