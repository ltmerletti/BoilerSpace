import { GRADESCOPE_ORIGIN, GRADESCOPE_SITES, gradescopeAssignments, gradescopeRequest } from './lib/gradescope.js';
import { SYLLABUS_SITE, isSyllabusAccessError } from './lib/syllabus-access.js';
import * as store from './lib/store.js';
import { DATA_EPOCH_KEY, dataRequest } from './lib/data-lifecycle.js';
import { AUTO_SYNC_INTERVAL_MS, BRIGHTSPACE_ORIGIN, canReachBrightspace, connectParentPage, syncNow } from './lib/sync.js';
import { lockIsFresh } from './lib/sync-store.js';
import { DEFAULT_MODEL, getConnection, linkAccount, refreshModels, setModel, unlink } from './lib/genai.js';
import { choosableFiles, chooseSyllabus, pendingReviews, processCurrentSyllabi, readUploadedSyllabus, usableRecord, withSyllabusSources } from './lib/syllabus.js';
import { agendaItems, calendarEvents, courseTitle, currentCourses, groupByDay, itemDayKey, shortCourseLabel } from './lib/planner.js';
import { buildCalendar } from './lib/ics.js';
import { locationUrl, syllabusFile } from './lib/links.js';
import { ask, SUGGESTED_QUESTIONS } from './lib/agent.js';
import { captureBenchmark } from './lib/capture.js';
import { addDaysToKey, dayKey, daysBetweenKeys, formatDateTime, formatDayKey, formatTime, relativeDay } from './lib/dates.js';
import { DISCUSSION_SITES, discussionName, discussionRequest, parseDiscussionUrl, recentDiscussionThreads } from './lib/discussions.js';
import { deadlineIssue } from './lib/deadline-status.js';
import { chatTitle, chatDate, generateChatTitle } from './lib/chat.js';
import { thinkingLevels, thinkingLabel, thinkingParams } from './lib/thinking.js';
import { createChatScrollFollow } from './lib/chat-scroll.js';
import { patchText, rememberTextSelection } from './lib/text-selection.js';

const sheet = document.createElement('link');
sheet.rel = 'stylesheet';
sheet.href = `sidepanel.css?v=${Date.now()}`;
sheet.onload = sheet.onerror = () => document.getElementById('boot')?.remove();
document.head.append(sheet);

const AGENDA_DAYS = 14;
const ANNOUNCEMENT_DAYS = 7;
const MAX_CHAT_MESSAGES = 40;
const MAX_CHATS = 30;
const MAX_THOUGHT_CHARS = 4000;
const VIEW_NAMES = ['week', 'courses', 'ask', 'settings'];
const THEMES = ['light', 'dark', 'system'];
const systemColorScheme = matchMedia('(prefers-color-scheme: dark)');
const QUIZ_ATTEMPT_PATH = '/d2l/lms/quizzing/user/attempt/';
const HOST_ORIGINS = ['https://purdue.brightspace.com/*', 'https://genai.rcac.purdue.edu/*', 'https://purdue.simplesyllabus.com/*'];
const PARAMS = new URLSearchParams(location.search);
const EMBEDDED = PARAMS.has('embedded');
const CONNECT_PAGE = PARAMS.has('connect');
const ACCESS_PAGE = PARAMS.has('syllabus-access');
const GRADESCOPE_ACCESS = PARAMS.has('gradescope-access');
const DISCUSSION_ACCESS = DISCUSSION_SITES[PARAMS.get('discussions-access')] ? PARAMS.get('discussions-access') : null;
const STOPPED_SYNC_NOTICE_MS = 10 * 60_000;

if (EMBEDDED) connectParentPage();

const STANCE_SENTENCE = {
  allowed: 'AI tools are allowed',
  restricted: 'AI tools are allowed with limits',
  prohibited: 'AI tools are not allowed',
  unclear: 'The syllabus does not say whether AI tools are allowed',
};

const state = {
  view: 'week',
  theme: 'system',
  courseId: null,
  snapshot: null,
  syncMeta: null,
  changes: [],
  genai: null,
  genaiError: '',
  syllabi: {},
  reviews: {},
  discussions: { sources: [] },
  gradescope: null,
  gradescopeError: '',
  gradescopeAccessDone: false,
  discussionError: '',
  discussionAccessDone: false,
  discussionPlatform: null,
  discussionConnecting: '',
  piazzaUrl: '',
  chats: [],
  activeChatId: null,
  showChats: false,
  openTraces: new Set(),
  askScope: '',
  thinkingByModel: {},
  draft: '',
  pending: null,
  abort: null,
  quizLocked: false,
  hostAccess: true,
  syllabusAccess: null,
  accessError: '',
  syncLock: null,
  progress: null,
  runningSync: false,
  quietSync: false,
  status: '',
  busy: { sync: false, syllabi: false, link: false, capture: false, discussions: false, discussionConnect: false, gradescope: false },
  linkStatus: '',
  linkError: '',
  syncError: '',
  modelsLoaded: false,
};

// ---------- DOM helper ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const isBrightspacePage = (href) => {
  try {
    const url = new URL(href);
    return url.origin === BRIGHTSPACE_ORIGIN && url.pathname.startsWith('/d2l/');
  } catch {
    return false;
  }
};

// Brightspace pages open in the Brightspace tab itself; files (like a PDF at a page) and other sites get a new tab.
async function openInBrightspace(url) {
  if (EMBEDDED) {
    window.parent.postMessage(JSON.stringify({ type: 'boilerspace-navigate', url }), BRIGHTSPACE_ORIGIN);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tab?.url?.startsWith(BRIGHTSPACE_ORIGIN) && !tab.url.includes(QUIZ_ATTEMPT_PATH)) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url });
}

function followLink(event) {
  const href = event.currentTarget.href;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !isBrightspacePage(href)) return;
  // Leaving the page would close the embedded panel and lose an answer that is still coming in.
  if (EMBEDDED && state.pending) return;
  event.preventDefault();
  openInBrightspace(href).catch(() => window.open(href, '_blank'));
}

const link = (href, text, props = {}) =>
  href ? h('a', { href, target: '_blank', rel: 'noreferrer', onclick: followLink, ...props }, text) : h('span', props, text);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const icon = (name) => document.getElementById(`icon-${name}`).content.cloneNode(true);

function disclosure(key, title, ...children) {
  return h('details', { 'data-disclosure': key }, h('summary', { 'data-focus-key': `disclosure-${key}` }, title), ...children);
}

function viewHeading(title, description) {
  return h('header', { class: 'view-heading' }, h('h2', null, title), description && h('p', { class: 'view-description' }, description));
}

// ---------- State ----------

// "page 3" as a link to that page of the course's syllabus, when the file can be opened there.
const pageRef = (courseId, page) => {
  const url = locationUrl(syllabusFile(usableRecord(state.syllabi[courseId]), state.snapshot), page);
  return url ? link(url, page) : page;
};

const courses = () => currentCourses(state.snapshot);
const courseById = (id) => state.snapshot?.courses.find((c) => c.id === id) ?? null;
const labelFor = (id) => {
  const course = courseById(id);
  return course ? shortCourseLabel(course) : '';
};

// Chats used to be one list under "chat"; keep it as the first session.
async function loadChats(all) {
  if (all.chats || !all.chat?.length) return all.chats ?? [];
  const at = new Date().toISOString();
  const first = all.chat.find((m) => m.role === 'user');
  const chats = [{ id: crypto.randomUUID(), title: chatTitle(first?.content ?? 'Earlier chat'), createdAt: at, updatedAt: at, messages: all.chat }];
  await dataRequest('save-chats', { chats, epoch: all[DATA_EPOCH_KEY] ?? 'initial' });
  await store.remove(store.KEYS.chat);
  return chats;
}

let stateLoadVersion = 0;
async function loadState({ includeChat = false } = {}) {
  const version = ++stateLoadVersion;
  const all = await store.getAll();
  const genai = all.genai ? await getConnection() : null;
  let chats;
  try { if (includeChat) chats = await loadChats(all); }
  catch (error) { if (error.code === 'data-cleared') return; throw error; }
  if (version !== stateLoadVersion) return;
  state.dataEpoch = all[DATA_EPOCH_KEY] ?? 'initial';
  applyTheme(all.theme ?? 'system');
  if (includeChat) {
    state.chats = chats;
    const ui = all.ui ?? {};
    if (VIEW_NAMES.includes(ui.view)) state.view = ui.view;
    state.courseId = ui.courseId ?? null;
    state.askScope = ui.askScope ?? '';
    state.thinkingByModel = ui.thinkingByModel ?? {};
    state.activeChatId = state.chats.some((c) => c.id === ui.activeChatId) ? ui.activeChatId : null;
  }
  state.snapshot = withSyllabusSources(all.snapshot, all.syllabusSources);
  state.syncMeta = all.syncMeta ?? null;
  state.changes = all.changes ?? [];
  state.genai = genai;
  state.syllabi = all.syllabi ?? {};
  state.syllabusAccess = all.syllabusAccess ?? null;
  state.reviews = all.reviews ?? {};
  state.discussions = all.discussions ?? { sources: [] };
  state.gradescope = all.gradescope ?? null;
  state.syncLock = all.syncLock ?? null;
  state.progress = all.syncProgress ?? null;
  state.busy.sync = computeSyncBusy();
}

const computeSyncBusy = () => state.runningSync || lockIsFresh(state.syncLock);

function setStatus(text) {
  state.status = text;
  renderStatus();
}

function renderStatus() {
  const el = document.getElementById('status');
  const p = state.progress;
  if (state.snapshot && state.busy.sync && (!state.runningSync || state.quietSync)) {
    el.hidden = true;
    return;
  }
  let text = state.status;
  let fraction = null;
  let bar = Boolean(text);
  if (state.busy.sync) {
    bar = true;
    if (p && !p.finished) {
      text = p.message;
      if (p.total) fraction = 0.1 + 0.85 * (p.done / p.total);
    } else {
      text ||= 'Syncing…';
    }
  } else if (!text && p && !p.finished && (!state.snapshot || state.syncMeta?.ok === false) && Date.now() - p.at < STOPPED_SYNC_NOTICE_MS) {
    text = 'The last sync stopped partway, probably because the Brightspace page changed. It tries again on the next page, or press sync.';
  }
  el.hidden = !text;
  const nodes = [h('span', null, text ?? '')];
  if (bar) nodes.push(h('div', { class: `progress${fraction === null ? ' indeterminate' : ''}` }, h('div', { class: 'progress-fill', style: fraction === null ? null : `width:${Math.round(fraction * 100)}%` })));
  el.replaceChildren(...nodes);
}

// ---------- Actions ----------

async function runSync({ quiet = false } = {}) {
  if (state.busy.sync) return;
  state.runningSync = true;
  state.quietSync = quiet;
  state.busy.sync = true;
  state.syncError = '';
  render();
  try {
    await syncNow({ onStatus: setStatus });
  } catch (err) {
    state.syncError = err.message;
  } finally {
    state.runningSync = false;
    setStatus('');
    await loadState();
    render();
    processSyllabi();
    refreshDiscussions();
  }
}

async function refreshDiscussions(force = false) {
  if (!state.discussions.sources.length) return;
  if (state.pending) {
    if (force) discussionRetryQueued = true;
    return;
  }
  if (state.busy.discussions) {
    if (force) discussionRetryQueued = true;
    return;
  }
  let sourceId;
  if (force) discussionRecoveryQueued = false;
  else if (discussionRecoveryQueued) {
    discussionRecoveryQueued = false;
    sourceId = state.discussions.sources.filter(source => source.status === 'error' || source.sync).map(source => source.id);
    if (!sourceId.length) return;
    force = true;
  }
  if (!force && !state.discussions.sources.some(source => source.status === 'syncing' || !source.lastAttemptAt || Date.now() - Date.parse(source.lastAttemptAt) >= 20 * 60_000)) return;
  state.busy.discussions = true;
  state.discussionError = '';
  render();
  try { await syncDiscussionBatches({ force, sourceId }); }
  catch (error) { state.discussionError = error.message; }
  finally {
    state.busy.discussions = false;
    await loadState(); render();
    if (discussionRefreshQueued || discussionRetryQueued || discussionRecoveryQueued) {
      const retry = discussionRetryQueued;
      discussionRefreshQueued = false;
      discussionRetryQueued = false;
      refreshDiscussions(retry);
    }
  }
}

let discussionRefreshQueued = false;
let discussionRetryQueued = false;
let discussionRecoveryQueued = false;

async function syncDiscussionBatches({ force = false, sourceId } = {}) {
  let result;
  do {
    result = await discussionRequest('sync', { force, sourceId });
    force = false;
    await loadState();
    render();
  } while (result.pending && !state.pending);
}

async function openDiscussionAccess(platform, courseUrl = null) {
  state.discussionPlatform = platform;
  state.discussionError = '';
  try {
    const value = courseUrl ?? state.piazzaUrl;
    const url = platform === 'piazza' && value.trim() ? parseDiscussionUrl(value).url : undefined;
    if (EMBEDDED) return await discussionRequest('open-access', { platform, url });
    // Firefox requires the permission request directly inside the button gesture.
    const permission = chrome.permissions.request({ origins: DISCUSSION_SITES[platform] });
    await connectDiscussions(platform, url, permission);
  } catch (error) { state.discussionError = error.message; render(); }
}

async function connectDiscussions(platform = DISCUSSION_ACCESS, url = PARAMS.get('course'), permission = null) {
  if (state.busy.discussionConnect) return;
  const allowed = permission ?? chrome.permissions.request({ origins: DISCUSSION_SITES[platform] });
  state.discussionError = '';
  state.discussionAccessDone = false;
  state.discussionPlatform = platform;
  state.busy.discussionConnect = true;
  let signInTab;
  try {
    const granted = await allowed;
    if (!granted) throw new Error('Site access was not allowed. Allow access to connect this discussion source.');
    state.discussionConnecting = `Finding your ${discussionName(platform)} courses…`;
    render();
    const deadline = Date.now() + 5 * 60_000;
    while (true) {
      try { await discussionRequest('connect', { platform, url }); break; }
      catch (error) {
        if (!/sign in|sign into|open a piazza class/i.test(error.message) || Date.now() >= deadline) throw error;
        if (!signInTab) {
          signInTab = await chrome.tabs.create({ url: 'about:blank', active: true });
          await chrome.tabs.update(signInTab.id, { url: platform === 'ed' ? 'https://edstem.org/us/' : url || 'https://piazza.com/' });
        }
        else if (!(await chrome.tabs.get(signInTab.id).catch(() => null))) throw new Error('Sign-in was closed. You can connect again whenever you are ready.', { cause: error });
        state.discussionConnecting = `Finish signing in to ${discussionName(platform)}${platform === 'piazza' ? ' and open your class' : ''}. Connection continues automatically.`;
        render();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    state.discussionAccessDone = true;
    if (platform === 'piazza') state.piazzaUrl = '';
  } catch (error) { state.discussionError = error.message; }
  finally {
    if (signInTab) await chrome.tabs.remove(signInTab.id).catch(() => {});
    state.busy.discussionConnect = false;
    state.discussionConnecting = '';
    await loadState(); render();
  }
  if (state.discussionAccessDone) {
    if (state.busy.discussions) discussionRefreshQueued = true;
    else refreshDiscussions(state.discussions.sources.some(source => source.platform === platform && source.status === 'error'));
  }
}

async function updateDiscussion(action, sourceId, courseId = null) {
  state.discussionPlatform = state.discussions.sources.find(source => source.id === sourceId)?.platform;
  state.discussionError = '';
  try { await discussionRequest(action, { sourceId, courseId }); }
  catch (error) { state.discussionError = error.message; }
  await loadState();
  render();
}

let queuedSyllabusRun = null;

async function processSyllabi(options = {}) {
  if (!state.genai || !state.snapshot) return;
  if (state.busy.syllabi) {
    if (!queuedSyllabusRun?.force) queuedSyllabusRun = options;
    return;
  }
  const { force = false, courseId = null } = options;
  state.busy.syllabi = true;
  render();
  try {
    await processCurrentSyllabi(state.snapshot, { force, courseId, openTab: force, onStatus: setStatus });
  } catch (error) {
    if (error.code !== 'data-cleared') throw error;
  } finally {
    state.busy.syllabi = false;
    setStatus('');
    await loadState();
    render();
    if (queuedSyllabusRun) {
      const next = queuedSyllabusRun;
      queuedSyllabusRun = null;
      processSyllabi(next);
    }
  }
}

async function pickSyllabus(courseId, value) {
  await chooseSyllabus(courseId, value || null);
  await processSyllabi({ force: true, courseId });
}

async function uploadSyllabus(courseId, file) {
  if (!file || state.busy.syllabi) return;
  const snapshot = state.snapshot;
  const epoch = state.dataEpoch;
  state.busy.syllabi = true;
  render();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await readUploadedSyllabus(snapshot, courseId, { bytes, fileName: file.name, contentType: file.type }, { onStatus: setStatus, epoch });
  } catch (error) {
    if (error.code !== 'data-cleared') throw error;
  } finally {
    state.busy.syllabi = false;
    setStatus('');
    await loadState();
    render();
  }
}

// An extension frame inside a website can't sign in to GenAI Studio itself (its cookies are partitioned),
// so the embedded panel hands linking to a normal extension tab.
function connectGenAI() {
  if (EMBEDDED) {
    window.open(chrome.runtime.getURL('sidepanel.html?connect=1'), '_blank');
    state.linkStatus = 'Finish connecting in the new tab.';
    render();
    return;
  }
  return linkHere();
}

async function linkHere() {
  state.busy.link = true;
  state.linkError = '';
  render();
  try {
    await linkAccount({
      onStatus: (text) => {
        state.linkStatus = text;
        render();
      },
    });
    state.genai = await getConnection();
    state.genaiError = '';
    state.modelsLoaded = Boolean(state.genai?.models?.length);
  } catch (err) {
    state.linkError = err.message;
  } finally {
    state.busy.link = false;
    state.linkStatus = '';
    render();
  }
  if (state.genai && !CONNECT_PAGE) processSyllabi();
  return Boolean(state.genai);
}

// ---------- Chats ----------

const activeChat = () => state.chats.find((c) => c.id === state.activeChatId) ?? null;
const chatMessages = () => activeChat()?.messages ?? [];

function saveUi() {
  const { view, courseId, askScope, activeChatId, thinkingByModel } = state;
  store.set(store.KEYS.ui, { view, courseId, askScope, activeChatId, thinkingByModel }).catch(() => {});
}

async function saveChats(epoch = state.dataEpoch) {
  state.chats = [...state.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_CHATS);
  await dataRequest('save-chats', { chats: state.chats, epoch });
}

function addMessage(chatId, message, epoch = state.dataEpoch) {
  const at = new Date().toISOString();
  state.chats = state.chats.map((c) => (c.id === chatId ? { ...c, updatedAt: at, messages: [...c.messages, message].slice(-MAX_CHAT_MESSAGES) } : c));
  return saveChats(epoch);
}

function openChat(id) {
  answerScroll.reset();
  state.activeChatId = id;
  state.showChats = false;
  state.openTraces.clear();
  saveUi();
  render();
  const chat = activeChat();
  if (chat && !chat.titleGenerated && chat.messages.some(message => message.role === 'assistant' && !message.error)) nameChat(id);
}

async function deleteChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.activeChatId === id) state.activeChatId = null;
  await saveChats();
  saveUi();
  render();
}

const storedTrace = (trace) =>
  trace.map((entry) => (entry.type === 'thought' ? { ...entry, text: entry.text.slice(-MAX_THOUGHT_CHARS) } : { ...entry, active: false }));

function stoppedDraft(message) {
  const tools = (message.trace ?? []).filter((entry) => entry.type === 'tool' && (entry.label || entry.summary));
  const work = tools.map((entry) => `${entry.label ?? entry.name}: ${entry.summary ?? 'done'}`).join('\n');
  const written = message.content && message.content !== 'Stopped.' ? message.content.trim() : '';
  const parts = [];
  if (work) parts.push(`Already checked:\n${work}`);
  if (written) parts.push(written);
  return parts.join('\n\n') || 'Stopped before writing an answer.';
}

async function sendQuestion(question, { reuse = false, resume = null } = {}) {
  const text = question.trim();
  if (!text || state.pending) return;
  const scopeCourseId = state.askScope ? Number(state.askScope) : null;
  let chat = activeChat();
  if (!chat) {
    const at = new Date().toISOString();
    chat = { id: crypto.randomUUID(), title: chatTitle(text), createdAt: at, updatedAt: at, messages: [] };
    state.chats = [chat, ...state.chats];
    state.activeChatId = chat.id;
    saveUi();
  }
  const chatId = chat.id;
  let history = resume?.history ?? null;
  if (!history) {
    let prior = chat.messages.filter((m) => !m.error && !m.stopped);
    if (reuse) {
      const at = prior.findLastIndex((m) => m.role === 'user' && m.content.trim() === text);
      if (at >= 0) prior = prior.slice(0, at);
    }
    history = prior.map(({ role, content }) => ({ role, content }));
  }
  state.draft = '';
  state.showChats = false;
  answerScroll.reset();
  const keptTrace = (resume?.trace ?? []).map((entry) => ({ ...entry, active: false }));
  state.pending = { chatId, runId: crypto.randomUUID(), trace: keptTrace, text: '', startedAt: Date.now(), open: true };
  state.abort = new AbortController();
  const pending = state.pending;
  const epoch = state.dataEpoch;
  if (!reuse && !resume) {
    try { await addMessage(chatId, { id: crypto.randomUUID(), role: 'user', content: text }, epoch); }
    catch (error) { if (error.code === 'data-cleared') return; throw error; }
  }
  if (state.pending !== pending) return;
  render({ bottom: true });
  const ticker = setInterval(() => {
    const clock = document.querySelector('#pending .trace-time');
    if (clock && state.pending) clock.textContent = duration(Math.floor((Date.now() - state.pending.startedAt) / 1000));
  }, 1000);
  let reply;
  try {
    const run = () => ask({
      question: text,
      history,
      snapshot: state.snapshot,
      syllabi: state.syllabi,
      reviews: state.reviews,
      discussions: state.discussions,
      gradescope: state.gradescope,
      scopeCourseId,
      requestParams: thinkingParams(state.genai?.model, state.thinkingByModel[state.genai?.model]),
      signal: state.abort.signal,
      onTrace: (trace) => {
        if (state.pending !== pending) return;
        state.pending.trace = [...keptTrace, ...trace];
        updatePending();
      },
      onText: (partial) => {
        if (state.pending !== pending) return;
        setPendingText(partial);
        updatePending();
      },
    });
    let answer;
    try { answer = await run(); }
    catch (error) {
      if (error.code !== 'discussion-data-changed' || state.abort.signal.aborted) throw error;
      await loadState();
      state.pending.trace = keptTrace;
      setPendingText('');
      updatePending();
      answer = await run();
    }
    reply = { role: 'assistant', content: answer.text, citations: answer.citations, trace: [...keptTrace, ...storedTrace(answer.trace)] };
  } catch (err) {
    if (state.pending !== pending) return;
    const stopped = err.name === 'AbortError' || state.abort?.signal.aborted;
    const partial = state.pending?.text?.trim() ?? '';
    reply = { role: 'assistant', content: stopped ? partial || 'Stopped.' : err.message, error: !stopped, stopped, trace: storedTrace(state.pending.trace) };
  } finally {
    clearInterval(ticker);
  }
  if (state.pending !== pending) return;
  rememberPendingDisclosure();
  reply.id = pending.runId;
  const pendingKey = `trace-${pending.chatId}-${pending.runId}`;
  const savedKey = `trace-${pending.chatId}-${reply.id}`;
  const keepWorkOpen = pending.open && (pending.manualDisclosure || !answerScroll.following);
  if (keepWorkOpen) state.openTraces.add(reply.id);
  for (const details of document.querySelectorAll('#pending details[data-disclosure]')) {
    const key = details.dataset.disclosure;
    if (key.startsWith(pendingKey)) expandedSections.set(savedKey + key.slice(pendingKey.length), key === pendingKey ? keepWorkOpen : details.open);
  }
  reply.seconds = Math.round((Date.now() - state.pending.startedAt) / 1000);
  state.pending = null;
  state.abort = null;
  try { await addMessage(chatId, reply, epoch); }
  catch (error) { if (error.code === 'data-cleared') return; throw error; }
  render();
  const retryDiscussions = discussionRetryQueued;
  discussionRetryQueued = false;
  refreshDiscussions(retryDiscussions);
  if (!reply.error && !reply.stopped && !chat.titleGenerated) nameChat(chatId);
}

const namingChats = new Set();
async function nameChat(id) {
  const chat = state.chats.find(chat => chat.id === id);
  if (!chat || namingChats.has(id)) return;
  namingChats.add(id);
  const epoch = state.dataEpoch;
  try {
    const title = await generateChatTitle(chat.messages, { signal: AbortSignal.timeout(30_000) });
    state.chats = state.chats.map(chat => chat.id === id ? { ...chat, title, titleGenerated: true } : chat);
    await saveChats(epoch);
    if (state.view === 'ask' && !state.pending) render();
  } catch { /* The short local title remains available if naming fails. */ }
  finally { namingChats.delete(id); }
}

async function retryMessage(index) {
  const chat = activeChat();
  if (!chat || state.pending) return;
  const failed = chat.messages[index];
  if (!failed || failed.role !== 'assistant') return;
  let question = '';
  for (let i = index - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') {
      question = chat.messages[i].content;
      break;
    }
  }
  if (!question.trim()) return;
  const at = new Date().toISOString();
  const messages = chat.messages.filter((_, i) => i !== index);
  state.chats = state.chats.map((c) => (c.id === chat.id ? { ...c, updatedAt: at, messages } : c));
  await saveChats();
  await sendQuestion(question, { reuse: true });
}

async function continueMessage(index) {
  const chat = activeChat();
  if (!chat || state.pending) return;
  const failed = chat.messages[index];
  if (!failed?.stopped) return;
  let question = '';
  let questionAt = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') {
      question = chat.messages[i].content;
      questionAt = i;
      break;
    }
  }
  if (!question.trim() || questionAt < 0) return;
  const kept = chat.messages.filter((_, i) => i !== index);
  const earlier = kept
    .slice(0, questionAt)
    .filter((m) => !m.error && !m.stopped)
    .map(({ role, content }) => ({ role, content }));
  const at = new Date().toISOString();
  state.chats = state.chats.map((c) => (c.id === chat.id ? { ...c, updatedAt: at, messages: kept } : c));
  await saveChats();
  await sendQuestion('Continue from where you stopped. Finish the answer from the work already done. Do not repeat those lookups.', {
    resume: {
      history: [...earlier, { role: 'user', content: question }, { role: 'assistant', content: stoppedDraft(failed) }],
      trace: failed.trace ?? [],
    },
  });
}

function download(fileName, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  h('a', { href: url, download: fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function exportCalendar() {
  const events = calendarEvents(state.snapshot, state.syllabi, state.reviews, state.gradescope);
  download('boilerspace.ics', buildCalendar(events, { name: 'BoilerSpace courses' }), 'text/calendar');
}

async function exportData() {
  const all = await store.getExportData();
  download(`boilerspace-data-${dayKey(new Date())}.json`, JSON.stringify(all, null, 2), 'application/json');
}

async function saveBenchmarkData() {
  if (state.busy.capture) return;
  state.busy.capture = true;
  render();
  try {
    const capture = await captureBenchmark({ snapshot: state.snapshot, syllabi: state.syllabi, chats: state.chats, onStatus: setStatus });
    download(`boilerspace-benchmark-${dayKey(new Date())}.json`, JSON.stringify(capture), 'application/json');
  } catch (err) {
    setStatus(`Could not save benchmark data: ${err.message}`);
  } finally {
    state.busy.capture = false;
    setStatus('');
    render();
  }
}

async function clearData() {
  if (!confirm('Delete all BoilerSpace data on this device? This also disconnects GenAI Studio.')) return;
  state.abort?.abort();
  state.pending = null;
  state.abort = null;
  queuedSyllabusRun = null;
  await dataRequest('clear');
  await loadState({ includeChat: true });
  state.view = 'settings';
  render();
}

// ---------- Shared views ----------

function itemMeta(item, { withCourse = true, withDay = false } = {}) {
  const parts = [];
  if (item.kind !== 'event') parts.push(item.kind);
  if (withDay) parts.push(formatDayKey(itemDayKey(item)));
  if (item.allDay) parts.push('all day');
  else if (item.kind === 'event' && item.endAt && item.endAt !== item.dueAt) parts.push(`${formatTime(item.dueAt)} to ${formatTime(item.endAt)}`);
  else parts.push(formatTime(item.dueAt));
  if (item.location) parts.push(item.location);
  const course = withCourse && (labelFor(item.courseId) || item.courseName);
  return [course && h('span', { class: 'item-course' }, course), course && ' ', parts.filter(Boolean).join(', ')];
}

function agendaItem(item, options) {
  const classes = ['item', item.source === 'syllabus' && 'syllabus', item.kind === 'exam' && 'exam'].filter(Boolean).join(' ');
  return h(
    'li',
    { class: classes },
    h('div', null, link(item.url, item.title, { class: 'item-title' })),
    h('div', { class: 'meta' }, itemMeta(item, options), item.source === 'syllabus' ? [' · ', 'Syllabus'] : item.source === 'gradescope' ? [' · ', 'Gradescope'] : null),
  );
}

// Firefox and Zen can install the extension without its site access, so ask for it here.
function syllabusAccessNotice() {
  const failed = Object.values(state.syllabi).some((record) => isSyllabusAccessError(record?.error));
  if (state.syllabusAccess === true || (state.syllabusAccess !== false && !failed)) return null;
  return h('div', { class: 'alert' }, h('p', null, 'Your syllabi open on Purdue Simple Syllabus. Allow BoilerSpace access to that site so it can read them.'),
    h('div', { class: 'button-row' }, h('button', { class: 'button', type: 'button', onclick: () => chrome.runtime.sendMessage({ type: 'boilerspace-open-syllabus-access' }) }, 'Allow Simple Syllabus access')));
}

function syllabusAccessPage() {
  return h('section', { class: 'setup' }, h('h2', { class: 'setup-intro' }, 'Read Purdue Simple Syllabus'),
    h('p', null, state.syllabusAccess ? 'Access is allowed. BoilerSpace will retry your syllabi automatically. You can close this tab.' : 'Purdue hosts your syllabi on purdue.simplesyllabus.com. Allow BoilerSpace to read that site through your existing browser session.'),
    state.accessError && h('p', { class: 'error-text' }, state.accessError),
    !state.syllabusAccess && h('button', { class: 'button', type: 'button', onclick: async () => {
      state.accessError = '';
      try {
        const granted = await chrome.permissions.request({ origins: [SYLLABUS_SITE] });
        const result = await chrome.runtime.sendMessage({ type: 'boilerspace-syllabus-access' });
        state.syllabusAccess = result?.granted === true;
        if (!granted) state.accessError = 'Access was not allowed. Your syllabus reading will resume when you allow this site.';
      } catch (err) { state.accessError = err.message; }
      render();
    } }, 'Allow Simple Syllabus access'));
}

function hostAccessNotice() {
  if (state.hostAccess || EMBEDDED) return null;
  const request = () =>
    chrome.permissions.request({ origins: HOST_ORIGINS }).then((granted) => {
      state.hostAccess = granted;
      render();
    });
  return h(
    'div',
    { class: 'alert' },
    h('p', null, h('strong', null, 'Allow BoilerSpace to read Brightspace and Purdue Simple Syllabus. '), 'GenAI Studio access is used to read syllabi and answer questions.'),
    h('div', { class: 'button-row' }, h('button', { class: 'button', type: 'button', onclick: request }, 'Allow access')),
  );
}

const syncFailure = () => state.syncError || (state.syncMeta?.ok === false ? state.syncMeta.error : '');

function setupView() {
  const synced = Boolean(state.snapshot);
  const connected = Boolean(state.genai);
  const brightspaceStep = h(
    'li',
    { class: `step${synced ? ' done' : ''}` },
    h('span', { class: 'step-mark' }, synced ? '✓' : '1'),
    h(
      'div',
      null,
      h('div', { class: 'step-title' }, synced ? 'Brightspace connected' : 'Brightspace'),
      !synced && h('p', null, 'Load courses from your signed-in account.'),
      !synced && !state.busy.sync && syncFailure() && h('p', { class: 'error-text small', style: 'margin-top:6px' }, syncFailure()),
      !synced && h('div', { class: 'button-row' }, h('button', { class: 'button', type: 'button', disabled: state.busy.sync, onclick: runSync }, state.busy.sync ? 'Loading…' : syncFailure() ? 'Try again' : 'Load my courses')),
    ),
  );
  const genaiStep = h(
    'li',
    { class: `step${connected ? ' done' : ''}` },
    h('span', { class: 'step-mark' }, connected ? '✓' : '2'),
    h(
      'div',
      null,
      h('div', { class: 'step-title' }, connected ? 'GenAI Studio connected' : 'Purdue GenAI Studio'),
      !connected && h('p', null, 'Read syllabi and ask questions using your Purdue account.'),
      state.linkStatus && h('p', { class: 'small', style: 'margin-top:6px' }, state.linkStatus),
      state.linkError && h('p', { class: 'small error-text', style: 'margin-top:6px' }, state.linkError),
      !connected && h('div', { class: 'button-row' }, h('button', { class: synced ? 'button' : 'button secondary', type: 'button', disabled: state.busy.link, onclick: connectGenAI }, state.busy.link ? 'Connecting…' : 'Connect')),
    ),
  );
  return h(
    'section',
    { class: 'setup' },
    h('h2', { class: 'setup-intro' }, 'Set up BoilerSpace'),
    h('ol', { class: 'steps' }, brightspaceStep, genaiStep),
    synced && h('div', { class: 'setup-discussions' }, h('h3', { class: 'heading' }, 'Discussions'), discussionConnection('ed'), discussionConnection('piazza')),
  );
}

function connectReminder() {
  if (state.genai) return null;
  return h(
    'section',
    { class: 'settings-group' },
    h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Connect Purdue GenAI Studio')),
    h('p', { class: 'muted small' }, 'Read syllabus dates and policies, and ask questions about your courses.'),
    state.linkStatus && h('p', { class: 'small', style: 'margin-top:6px' }, state.linkStatus),
    state.linkError && h('p', { class: 'small error-text', style: 'margin-top:6px' }, state.linkError),
    h('div', { class: 'button-row' }, h('button', { class: 'button', type: 'button', disabled: state.busy.link, onclick: connectGenAI }, state.busy.link ? 'Connecting…' : 'Connect GenAI Studio')),
  );
}

function syncErrorNotice() {
  if (!state.syncMeta || state.syncMeta.ok || !state.snapshot) return null;
  return h(
    'div',
    { class: 'alert' },
    h('p', null, h('strong', null, 'The last sync failed. '), state.syncMeta.error),
    h('p', { class: 'meta', style: 'margin-top:2px' }, `Showing data from ${formatDateTime(state.syncMeta.lastSuccessAt)}.`),
  );
}

// ---------- Week ----------

function changeText(change) {
  switch (change.type) {
    case 'new':
      return [`New ${change.kind}: `, change.title];
    case 'due-changed':
      return ['Due date changed: ', change.title];
    case 'announcement':
      return ['Announcement: ', change.title];
    case 'new-file':
      return ['New file: ', change.title];
    case 'file-updated':
      return ['File updated: ', change.title];
    default:
      return ['', change.title];
  }
}

function changeMeta(change) {
  const parts = [labelFor(change.courseId)];
  if (change.type === 'due-changed') parts.push(`was ${change.from ? formatDateTime(change.from) : 'no due date'}, now ${change.to ? formatDateTime(change.to) : 'no due date'}`);
  else if (change.type === 'new' && change.to) parts.push(`due ${formatDateTime(change.to)}`);
  parts.push(`seen ${relativeDay(change.detectedAt)}`);
  return parts.filter(Boolean).join(', ');
}

function changesSection() {
  if (!state.changes.length) return null;
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'What changed'), h('button', { class: 'text-button', type: 'button', onclick: () => store.set(store.KEYS.changes, []) }, 'Clear')),
    h(
      'ul',
      { class: 'list' },
      state.changes.slice(0, 6).map((change) => {
        const [prefix, title] = changeText(change);
        return h('li', null, h('span', { class: 'change-type' }, prefix), link(change.url, title), h('div', { class: 'meta' }, changeMeta(change)));
      }),
    ),
    state.changes.length > 6 && h('p', { class: 'meta' }, `${state.changes.length - 6} more`),
  );
}

function reviewCard(d) {
  const notes = [];
  if (d.matchedItem && d.dateDiffers) notes.push(`Brightspace has "${d.matchedItem.title}" on ${formatDateTime(d.matchedItem.dueAt)}.`);
  if (!d.matchedItem) notes.push('This date is left out of your agenda until the source is clear.');
  const when = d.dueAt ? formatDateTime(d.dueAt, { year: true }) : `${formatDayKey(d.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, no time given`;
  return h(
    'div',
    { class: 'review' },
    h('div', { class: 'row-title' }, d.title),
    h('div', { class: 'meta' }, h('span', { class: 'item-course' }, labelFor(d.courseId)), ` ${d.kind}, ${when}`),
    h('p', { class: 'small muted' }, deadlineIssue(d)),
    h('p', { class: 'quote' }, `"${d.quote}" (`, pageRef(d.courseId, d.page), ')'),
    notes.map((n) => h('p', { class: 'note' }, n)),
  );
}

function reviewSection(limit = 3) {
  const pending = pendingReviews(state.syllabi, state.reviews);
  if (!pending.length) return null;
  return h(
    'section',
    { class: 'section' },
    disclosure('date-differences', h('span', null, 'Syllabus date differences', h('span', { class: 'count' }, pending.length)),
    h('p', { class: 'meta', style: 'margin-top:10px' }, 'Clear syllabus dates appear automatically. These sources disagree, so your agenda keeps the Brightspace date when one is available.'),
    pending.slice(0, limit).map(reviewCard),
    pending.length > limit && h('p', { class: 'meta', style: 'padding-top:6px' }, `${pending.length - limit} more on each course page.`),
    ),
  );
}

function agendaSection() {
  const today = dayKey(new Date());
  const end = addDaysToKey(today, AGENDA_DAYS - 1);
  const all = agendaItems(state.snapshot, state.syllabi, state.reviews, state.gradescope);
  const items = all.filter((item) => {
    const key = itemDayKey(item);
    return key >= today && key <= end;
  });
  const groups = groupByDay(items);
  if (!groups.has(today)) groups.set(today, []);
  const keys = [...groups.keys()].sort();
  let lastMonth = today.slice(0, 7);
  const days = keys.map((key) => {
    const offset = daysBetweenKeys(today, key);
    const month = key.slice(0, 7);
    const weekday = formatDayKey(key, { weekday: 'short' });
    const name = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : month !== lastMonth ? `${weekday}, ${formatDayKey(key, { month: 'short' })}` : weekday;
    lastMonth = month;
    const isWeekend = ['Sat', 'Sun'].includes(weekday);
    const dayItems = groups.get(key);
    return h(
      'section',
      { class: ['day', offset === 0 && 'today', isWeekend && 'weekend'].filter(Boolean).join(' ') },
      h('div', { class: 'day-date' }, h('span', { class: 'day-num' }, formatDayKey(key, { month: 'short', day: 'numeric' })), h('span', { class: 'day-name' }, name)),
      dayItems.length ? h('ul', { class: 'day-items' }, dayItems.map((item) => agendaItem(item))) : h('p', { class: 'day-empty' }, 'Nothing due.'),
    );
  });
  const laterCount = all.filter((item) => itemDayKey(item) > end).length;
  return [
    h('div', { class: 'section', style: 'padding-top:14px' }, h('div', { class: 'section-head', style: 'margin-bottom:0' }, h('h2', { class: 'heading' }, 'Next two weeks'), h('span', { class: 'meta' }, plural(items.length, 'item')))),
    h('div', { class: 'agenda' }, days),
    laterCount > 0 && h('p', { class: 'later meta' }, `${laterCount} more after ${formatDayKey(end)}. Each course page has the full list.`),
  ];
}

function announcementsSection() {
  const cutoff = Date.now() - ANNOUNCEMENT_DAYS * 86_400_000;
  const recent = (state.snapshot?.data ?? [])
    .flatMap((d) => d.announcements)
    .filter((a) => !a.isHidden && a.postedAt && Date.parse(a.postedAt) > cutoff && Date.parse(a.postedAt) <= Date.now())
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .slice(0, 5);
  if (!recent.length) return null;
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Announcements this week')),
    h('ul', { class: 'list' }, recent.map((a) => h('li', null, link(a.url, a.title, { class: 'row-title' }), h('div', { class: 'meta' }, h('span', { class: 'item-course' }, labelFor(a.courseId)), ` ${relativeDay(a.postedAt)}`)))),
  );
}

function weekView() {
  if (!state.snapshot) return [setupView()];
  const today = dayKey(new Date());
  const date = formatDayKey(today, { weekday: 'long', month: 'long', day: 'numeric' });
  return [
    syncErrorNotice(),
    viewHeading('Week', date),
    connectReminder(),
    agendaSection(),
    changesSection(),
    reviewSection(),
    announcementsSection(),
  ];
}

// ---------- Courses ----------

function syllabusTag(known, status) {
  if (status === 'error') return h('span', { class: 'tag' }, 'Syllabus check failed');
  if (!known && status === 'none') return h('span', { class: 'tag' }, 'No syllabus found');
  if (!known) return h('span', { class: 'tag' }, 'Syllabus not read');
  return null;
}

function coursesList() {
  const list = courses();
  if (!list.length) return [h('p', { class: 'lede' }, 'No current courses were found.')];
  const items = agendaItems(state.snapshot, state.syllabi, state.reviews, state.gradescope);
  const now = new Date().toISOString();
  return [
    viewHeading('Courses'),
    state.genai && h('div', { class: 'syllabus-controls' },
      h('p', { class: 'meta', id: 'syllabus-sync-status' }, syllabusSyncLine()),
      h('button', { class: 'text-button', type: 'button', disabled: state.busy.syllabi, onclick: () => processSyllabi({ force: true }) }, 'Check again'),
    ),
    list.map((course) => {
      const next = items.find((i) => i.courseId === course.id && i.dueAt >= now);
      const record = usableRecord(state.syllabi[course.id]);
      const title = courseSubtitle(course);
      return h(
        'button',
        { class: 'course-row', type: 'button', onclick: () => ((state.courseId = course.id), saveUi(), render({ top: true })) },
        h('span', { class: 'course-label' }, shortCourseLabel(course)),
        syllabusTag(Boolean(record), state.syllabi[course.id]?.status),
        title && h('div', { class: 'meta' }, title),
        h('div', { class: 'course-connections' }, state.discussions.sources.filter(source => source.courseId === course.id).map(source => h('span', { class: 'source-chip' }, h('span', { class: 'status-dot' }), discussionName(source.platform)))),
        h('div', { class: 'small', style: 'margin-top:2px' }, next ? `Next: ${next.title}, ${formatDateTime(next.dueAt, { allDay: next.allDay })}` : h('span', { class: 'muted' }, 'Nothing upcoming')),
      );
    }),
    excludedNote(),
  ];
}

function syllabusSyncLine() {
  if (state.busy.syllabi) return 'Reading your syllabi…';
  const checks = courses().map(course => state.syllabi[course.id])
    .filter(record => record && record.status !== 'error')
    .map(record => Date.parse(record.checkedAt ?? record.extractedAt)).filter(Number.isFinite);
  return checks.length ? `Syllabi last synced ${syncAge(Math.max(...checks))}` : 'Syllabi not synced yet';
}

function courseSubtitle(course) {
  const title = courseTitle(course).replace(/^[\s-]+/, '');
  if (title === shortCourseLabel(course) || /^[A-Z]{2,5}\s?\d{5}(?:[-\s]+(?:LE\d+|\d{1,4}|LEC|LAB|REC))*$/i.test(title)) {
    return /^(Fall|Spring|Summer|Winter)\s+\d{4}/i.exec(course.name)?.[0] ?? '';
  }
  return title;
}

function excludedNote() {
  const excluded = (state.snapshot?.courses ?? []).filter((c) => !c.current);
  if (!excluded.length) return null;
  return h(
    'details',
    { class: 'section' },
    h('summary', null, `${plural(excluded.length, 'older or inactive enrollment')} hidden`),
    h('ul', { class: 'list', style: 'margin-top:8px' }, excluded.map((c) => h('li', null, h('div', null, c.name), h('div', { class: 'meta' }, c.reason)))),
  );
}

function policyBlock(record) {
  const ai = record.policies.aiUse;
  return disclosure(`ai-policy-${record.courseId}`, 'AI policy',
    h('div', { class: 'policy-stance' }, `${STANCE_SENTENCE[ai.stance]}.`),
    ai.summary && h('p', { class: 'small', style: 'margin-top:2px' }, ai.summary),
    ai.quote && h('p', { class: 'quote' }, `"${ai.quote}" (`, pageRef(record.courseId, ai.page), ')'),
  );
}

function syllabusStatusLine(raw) {
  if (!raw) return state.genai ? (state.busy.syllabi ? 'Reading…' : 'Not read yet.') : 'Connect GenAI Studio to read it.';
  if (raw.status === 'none') return 'No syllabus was found for this course. Some courses do not post one.';
  if (raw.status === 'external') return `The syllabus is a link to ${raw.externalUrl ? new URL(raw.externalUrl).hostname : 'another site'}, which BoilerSpace can't open. Upload a copy to read it.`;
  if (raw.status === 'unreadable') return raw.warning;
  if (raw.status === 'error') return `Reading failed: ${raw.error}`;
  const pages = raw.pages?.length ?? 0;
  const unit = raw.kind === 'pptx' ? 'slide' : raw.kind === 'pdf' ? 'page' : 'part';
  return `Read ${formatDateTime(raw.extractedAt)}, ${plural(pages, unit)}${raw.source === 'upload' ? ', from your upload' : ''}.`;
}

function factBlock(courseId, term, fact) {
  return [
    h('dt', null, term),
    h(
      'dd',
      null,
      fact
        ? [h('div', null, fact.summary), h('details', null, h('summary', null, `Syllabus wording, ${fact.page}`), h('p', { class: 'quote' }, `"${fact.quote}" (`, pageRef(courseId, fact.page), ')'))]
        : h('span', { class: 'muted' }, 'Not stated in the syllabus.'),
    ),
  ];
}

function syllabusPicker(course, raw, data) {
  if (!state.genai) return null;
  const files = choosableFiles(data ?? {});
  const current = raw?.source === 'upload' ? 'upload' : raw?.chosen ? String(raw.topicId) : '';
  const missing = !raw || ['none', 'external', 'unreadable', 'error'].includes(raw.status);
  const controls = h(
    'div',
    { class: 'picker' },
    files.length > 0 &&
      h(
        'label',
        { class: 'meta' },
        'Use this file as the syllabus',
        h(
          'select',
          { disabled: state.busy.syllabi, onchange: (e) => pickSyllabus(course.id, e.target.value) },
          h('option', { value: '' }, 'Let BoilerSpace choose'),
          current === 'upload' && h('option', { value: 'upload', selected: true }, `Your upload: ${raw.title}`),
          files.map((t) => h('option', { value: String(t.id), selected: current === String(t.id) }, [...t.modulePath, t.title].join(' / '))),
        ),
      ),
    h(
      'div',
      { class: 'button-row' },
      h(
        'label',
        { class: 'button secondary upload' },
        'Upload the syllabus',
        h('input', { type: 'file', accept: '.pdf,.docx,.docm,.dotx,.dotm,.pptx,.pptm,.ppsx,.ppsm,.potx,.potm,.rtf,.html,.htm,.txt,.md', disabled: state.busy.syllabi, onchange: (e) => uploadSyllabus(course.id, e.target.files?.[0]) }),
      ),
      raw?.source !== 'upload' && h('button', { class: 'button secondary', type: 'button', disabled: state.busy.syllabi, onclick: () => processSyllabi({ force: true, courseId: course.id }) }, raw?.topicId ? 'Read again' : raw ? 'Check again' : 'Check for syllabus'),
    ),
  );
  if (raw?.status === 'none') return disclosure(`syllabus-file-${course.id}`, 'Add a syllabus', controls);
  return missing ? controls : disclosure(`syllabus-file-${course.id}`, 'Choose a different syllabus', controls);
}

function courseDetail(course) {
  const raw = state.syllabi[course.id];
  const record = usableRecord(raw);
  const data = state.snapshot.data.find((d) => d.courseId === course.id);
  const now = new Date().toISOString();
  const upcoming = agendaItems(state.snapshot, state.syllabi, state.reviews, state.gradescope).filter((i) => i.courseId === course.id && i.dueAt >= now);
  const files = (data?.content ?? []).filter((t) => !t.isHidden);
  const pending = pendingReviews(state.syllabi, state.reviews).filter((d) => d.courseId === course.id);
  const grading = record?.policies.grading ?? [];
  const gradingTotal = grading.reduce((s, g) => s + g.weight, 0);

  return [
    h('div', { class: 'back' }, h('button', { class: 'back-button', type: 'button', onclick: () => ((state.courseId = null), saveUi(), render({ top: true })) }, icon('chevron'), 'All courses')),
    h('header', { class: 'course-head' }, h('h2', null, shortCourseLabel(course)), h('p', { class: 'muted' }, courseTitle(course), ' ', link(course.homeUrl, 'Open in Brightspace', { class: 'small' }))),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Syllabus')),
      raw?.title && h('p', null, link(raw.externalUrl ?? raw.url, raw.title)),
      h('p', { class: 'meta' }, syllabusStatusLine(raw)),
      raw?.status !== 'done' && record && h('p', { class: 'meta' }, 'Showing what was read last time.'),
      record?.warning && h('p', { class: 'note' }, record.warning),
      record?.dropped?.length > 0 && h('p', { class: 'meta', style: 'margin-top:4px' }, `${plural(record.dropped.length, 'item was', 'items were')} left out because the wording could not be found in the file.`),
      syllabusPicker(course, raw, data),
      record && policyBlock(record),
    ),
    record &&
      h(
        'section',
        { class: 'section' },
        h('dl', { class: 'facts' }, factBlock(course.id, 'Late work', record.policies.lateWork), factBlock(course.id, 'Attendance', record.policies.attendance), factBlock(course.id, 'Office hours', record.policies.officeHours)),
      ),
    grading.length > 0 &&
      h(
        'section',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Grade weights')),
        h('table', { class: 'weights' }, h('tbody', null, grading.map((g) => h('tr', null, h('td', null, g.component), h('td', null, `${g.weight}%`))))),
        !record.policies.gradingAddsUp && h('p', { class: 'meta', style: 'margin-top:4px' }, `These add up to ${Math.round(gradingTotal * 10) / 10}%, so the syllabus may describe weights differently. Check the original.`),
      ),
    pending.length > 0 && h('section', { class: 'section' }, disclosure(`course-dates-${course.id}`, 'Where syllabus dates differ', pending.map(reviewCard))),
    state.gradescope?.courses.some(source => source.courseId === course.id) && h('section', { class: 'section' },
      h('h2', { class: 'heading' }, 'Gradescope'),
      gradescopeCourseList(state.gradescope.courses.filter(source => source.courseId === course.id), false),
    ),
    state.discussions.sources.some((s) => s.courseId === course.id) && h('section', { class: 'section' },
      h('h2', { class: 'heading' }, 'Discussions'),
      state.discussions.sources.filter((s) => s.courseId === course.id).map((source) => h('div', { class: 'discussion-preview' },
        h('p', { class: 'meta' }, `${discussionName(source.platform)} · ${source.status === 'syncing' ? 'Syncing…' : source.lastSyncedAt ? `Synced ${formatDateTime(source.lastSyncedAt)}` : 'Not synced yet'}`),
        source.error && h('p', { class: 'small error-text' }, source.error),
        link(source.url, `Open ${discussionName(source.platform)}`, { class: 'small discussion-open' }),
        disclosure(`recent-posts-${source.id}`, 'Recent posts',
          recentDiscussionThreads(source).length
            ? h('ul', { class: 'list' }, recentDiscussionThreads(source).map((thread) => h('li', null, link(thread.url, thread.title), h('div', { class: 'meta' }, `${formatDateTime(thread.createdAt)}${thread.role === 'instructor' ? ' · Instructor post' : ''}`))))
            : h('p', { class: 'meta' }, 'No posts in the last 7 days.'),
        ),
      )),
    ),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Coming up')),
      upcoming.length ? h('ul', { class: 'list' }, upcoming.slice(0, 25).map((item) => agendaItem(item, { withCourse: false, withDay: true }))) : h('p', { class: 'muted' }, 'Nothing upcoming.'),
    ),
    files.length > 0 &&
      h(
        'details',
        { class: 'section' },
        h('summary', null, `${plural(files.length, 'item')} in Content`),
        h('ul', { class: 'list', style: 'margin-top:8px' }, files.slice(0, 80).map((t) => h('li', null, link(t.url, t.title), h('div', { class: 'meta' }, t.modulePath.join(' / '))))),
      ),
  ];
}

function coursesView() {
  if (!state.snapshot) return [setupView()];
  const course = state.courseId && courseById(state.courseId);
  return course ? courseDetail(course) : coursesList();
}

// ---------- Ask ----------

function inlineNodes(text, citations) {
  const nodes = [];
  const pattern = /\*\*([^*]+)\*\*|\[((?:(?:S)?\d+(?:,\s*)?)+)\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(last, match.index));
    if (match[1]) nodes.push(h('strong', null, match[1]));
    else {
      for (const id of match[2].match(/S?\d+/g)) {
        const index = id.startsWith('S') ? citations.findIndex((c) => c.id === id) : Number(id) - 1;
        const source = citations[index];
        if (!source) continue;
        nodes.push(link(source.url, String(index + 1), { class: 'cite', title: source.label }));
      }
    }
    last = match.index + match[0].length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

function answerBody(text, citations = [], selectionKey = null) {
  const blocks = [];
  let list = null;
  for (const line of text.split('\n')) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      list ??= h('ul');
      list.append(h('li', null, inlineNodes(bullet[1], citations)));
      continue;
    }
    if (list) {
      blocks.push(list);
      list = null;
    }
    if (line.trim()) blocks.push(h('p', null, inlineNodes(line.replace(/^#+\s*/, ''), citations)));
  }
  if (list) blocks.push(list);
  if (selectionKey) blocks.forEach((block, index) => { block.dataset.selectionKey = `${selectionKey}-${index}`; });
  return blocks;
}

const duration = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`);

const formatArgs = (args) =>
  Object.entries(args ?? {})
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? `"${value}"` : JSON.stringify(value)}`)
    .join(', ');

const TOOL_TITLES = {
  list_courses: 'Find courses',
  list_upcoming: 'Check upcoming work',
  list_items: 'Find quizzes and assignments',
  get_item: 'Read assignment',
  read_quiz: 'Read quiz',
  search_course_material: 'Search course material',
  get_syllabus_facts: 'Check syllabus',
  list_announcements: 'Find announcements',
  list_discussions: 'Find Ed and Piazza posts',
  read_discussion: 'Read discussion and replies',
  list_course_files: 'Find course files',
  read_course_file: 'Read course file',
  list_gradescope_assignments: 'Check Gradescope assignments',
};

function traceStep(entry, key) {
  const failed = entry.summary?.startsWith('Failed');
  const stopped = entry.name && !entry.active && !entry.summary;
  const status = entry.active ? 'running' : failed ? 'failed' : stopped ? 'stopped' : 'complete';
  return h(
    'li',
    { class: `tool-step ${status}`, 'data-step-key': key, 'data-tool': entry.name, 'aria-busy': String(Boolean(entry.active)) },
    h('span', { class: `tool-status${entry.active ? ' spinner' : ''}`, 'aria-label': entry.active ? 'Running' : failed ? 'Failed' : stopped ? 'Stopped' : 'Complete' }, entry.active ? null : failed ? '!' : stopped ? '–' : '✓'),
    h('div', { class: 'tool-content' },
      h('div', { class: 'trace-label' }, TOOL_TITLES[entry.name] ?? entry.name?.replaceAll('_', ' ') ?? entry.label),
      entry.name && h('div', { class: 'tool-action' }, entry.label),
      entry.args?.query && h('div', { class: 'tool-query' }, `“${entry.args.query}”`),
      h('div', { class: 'tool-result' }, entry.active ? 'Running…' : stopped ? 'Stopped' : entry.summary),
      entry.name && h('details', { class: 'tool-call', 'data-disclosure': `${key}-arguments` },
        h('summary', { 'data-focus-key': `${key}-arguments` }, 'Details', icon('chevron')),
        h('code', null, `${entry.name}(${formatArgs(entry.args)})`),
        entry.details?.length > 0 && h('dl', { class: 'tool-preview' }, entry.details.map(item => [h('dt', null, item.label), h('dd', null, item.text)]))),
    ),
  );
}

function traceView(trace, { key, live = false, seconds = 0, open = false, ontoggle, writing = false }) {
  if (!trace.length && !live) return null;
  const tools = trace.filter((e) => e.type === 'tool');
  let summary;
  if (live) {
    const active = tools.findLast(entry => entry.active);
    const doing = writing ? 'Writing' : active ? (TOOL_TITLES[active.name] ?? active.label) : tools.length ? 'Reviewing results' : 'Thinking';
    summary = [h('span', { class: 'spinner' }), h('span', { class: 'trace-current', role: 'status' }, doing), h('span', { class: 'trace-time' }, duration(seconds)), icon('chevron')];
  } else {
    const time = seconds ? ` in ${duration(seconds)}` : '';
    summary = [icon('chevron'), tools.length ? `Used ${plural(tools.length, 'tool')}${time}` : `Thought${seconds ? ` for ${duration(seconds)}` : ''}`];
  }
  return h(
    'details',
    { class: `trace${live ? ' live' : ''}`, 'data-disclosure': key, open, ontoggle },
    h('summary', { 'data-focus-key': `${key}-toggle` }, summary),
    trace.some(entry => entry.type !== 'thought') && h('ol', { class: 'trace-steps', 'aria-label': 'Tool activity' }, trace.map((entry, index) =>
      entry.type === 'thought' ? null : entry.type === 'commentary'
        ? h('li', { class: 'trace-commentary', 'data-step-key': `${key}-commentary-${index}` }, answerBody(entry.text))
        : traceStep(entry, `${key}-tool-${index}`))),
    trace.some(entry => entry.type === 'thought' && entry.text) && h('details', { class: 'trace-reasoning', 'data-disclosure': `${key}-reasoning` },
      h('summary', { 'data-focus-key': `${key}-reasoning` }, 'Reasoning'),
      h('div', { class: 'thought-text' }, trace.filter(entry => entry.type === 'thought').map(entry => h('p', null, entry.text)))),
  );
}

// Messages saved before the work log existed only have step labels.
const messageTrace = (message) => message.trace ?? (message.steps ?? []).map((label) => ({ type: 'tool', label }));

const messageSnapshots = new WeakMap();
const messageKey = (message, index) => message.id ?? `i${index}`;
// Chrome storage can reorder object keys; that alone does not change an answer.
const chatSignature = message => JSON.stringify(message, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);

function messageView(message, index) {
  const node = savedMessageView(message, index);
  node.dataset.messageKey = messageKey(message, index);
  messageSnapshots.set(node, chatSignature(message));
  return node;
}

function savedMessageView(message, index) {
  const key = message.id ?? `i${index}`;
  const selectionKey = `message-${state.activeChatId}-${key}`;
  if (message.role === 'user') return h('div', { class: 'message user', 'data-selection-key': selectionKey }, message.content);
  const currentIndex = () => message.id ? chatMessages().findIndex(item => item.id === message.id) : index;
  const trace = traceView(messageTrace(message), {
    key: `trace-${state.activeChatId}-${key}`,
    seconds: message.seconds ?? 0,
    open: state.openTraces.has(key),
    ontoggle: (e) => {
      if (e.target !== e.currentTarget || !e.currentTarget.isConnected) return;
      e.currentTarget.open ? state.openTraces.add(key) : state.openTraces.delete(key);
    },
  });
  const latest = index === chatMessages().length - 1;
  const actions =
    latest &&
    h(
      'div',
      { class: 'message-actions' },
      message.stopped && h('button', { class: 'text-button', type: 'button', disabled: Boolean(state.pending), onclick: () => continueMessage(currentIndex()) }, icon('continue'), 'Continue'),
      !message.error && h('button', { class: 'icon-button', type: 'button', title: 'Copy answer', 'aria-label': 'Copy answer', onclick: async (event) => {
        const button = event.currentTarget;
        try {
          await navigator.clipboard.writeText(message.content);
          button.title = 'Copied';
          button.setAttribute('aria-label', 'Copied');
          button.replaceChildren(h('span', { 'aria-hidden': 'true' }, '✓'));
          setTimeout(() => {
            button.title = 'Copy answer';
            button.setAttribute('aria-label', 'Copy answer');
            button.replaceChildren(icon('copy'));
          }, 1500);
        } catch { setStatus('Could not copy the answer. Select its text to copy it.'); }
      } }, icon('copy')),
      h('button', { class: 'icon-button', type: 'button', title: 'Retry', 'aria-label': 'Retry', disabled: Boolean(state.pending), onclick: () => retryMessage(currentIndex()) }, icon('retry'), h('span', { class: 'sr-only' }, 'Retry')),
    );
  if (message.error || message.stopped) {
    return h(
      'div',
      { class: `message assistant${message.error ? ' error' : ' stopped'}` },
      trace,
      h('p', null, message.content),
      actions,
    );
  }
  const citations = message.citations ?? [];
  return h(
    'div',
    { class: 'message assistant' },
    trace,
    answerBody(message.content, citations, selectionKey),
    h('div', { class: 'answer-footer' },
      citations.length > 0 && disclosure(`sources-${state.activeChatId}-${key}`, `${plural(citations.length, 'source')}`,
        h('div', { class: 'sources' }, citations.map((c, i) => link(c.url, [h('span', { class: 'cite' }, i + 1), h('span', null, c.label)], { title: c.label })))),
      actions,
    ),
  );
}

function pendingView() {
  const p = state.pending;
  const trace = traceView(p.trace, {
    key: `trace-${p.chatId}-${p.runId}`,
    live: true,
    writing: Boolean(p.text),
    seconds: Math.floor((Date.now() - p.startedAt) / 1000),
    open: p.open,
    ontoggle: (e) => {
      const el = e.currentTarget;
      if (e.target === el && el.isConnected && state.pending === p) p.open = el.open;
    },
  });
  trace.dataset.pendingTrace = 'true';
  return h(
    'div',
    { class: 'message assistant pending', id: 'pending', 'data-message-key': p.runId, style: `--activity-delay:-${(Date.now() - p.startedAt) % 1200}ms`, onclick: event => {
      if (state.pending?.runId === event.currentTarget.dataset.messageKey && event.target.closest('summary')) state.pending.manualDisclosure = true;
    } },
    trace,
    p.text && h('div', { class: 'streaming-answer' }, answerBody(p.text, [], `message-${p.chatId}-${p.runId}`)),
  );
}

let pendingFrame = null;
const answerScroll = createChatScrollFollow();

function setPendingText(text) {
  // A draft can still precede a tool. Its text must not toggle the work log.
  state.pending.text = text;
}

function rememberPendingDisclosure() {
  const p = state.pending;
  const trace = document.querySelector('#pending > .trace');
  // A previous question's DOM must not change this question's disclosure.
  if (p && trace?.dataset.disclosure === `trace-${p.chatId}-${p.runId}`) p.open = trace.open;
}

// Patch the live answer in place so pointer-down targets survive the next token.
function patchPendingNode(current, next) {
  if (current.nodeType === Node.TEXT_NODE) {
    patchText(current, next.data);
    return;
  }
  for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of next.attributes) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  const key = node => node.nodeType === Node.ELEMENT_NODE ? node.dataset.disclosure ?? node.dataset.stepKey : null;
  const existing = new Map([...current.childNodes].filter(node => key(node)).map(node => [key(node), node]));
  const kept = new Set();
  for (const [index, child] of [...next.childNodes].entries()) {
    const candidate = key(child) ? existing.get(key(child)) : current.childNodes[index];
    const compatible = candidate && (key(child) || !key(candidate)) && candidate.nodeType === child.nodeType && candidate.nodeName === child.nodeName;
    const element = compatible ? candidate : child;
    if (element !== current.childNodes[index]) current.insertBefore(element, current.childNodes[index] ?? null);
    if (compatible) patchPendingNode(element, child);
    kept.add(element);
  }
  for (const child of [...current.childNodes]) if (!kept.has(child)) child.remove();
}

function updatePending() {
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    paintPending();
  });
}

function paintPending() {
  const el = document.getElementById('pending');
  if (!el || !state.pending) return;
  const main = document.querySelector('.messages');
  if (!main) return;
  const restoreSelection = rememberTextSelection(main);
  rememberPendingDisclosure();
  const scroll = main.scrollTop;
  const disclosures = [...el.querySelectorAll('details[data-disclosure]')].map(details => ({ key: details.dataset.disclosure, open: details.open, scroll: details.querySelector('.thought-text')?.scrollTop }));
  const focusKey = el.contains(document.activeElement) && document.activeElement.dataset.focusKey;
  const next = pendingView();
  for (const details of next.querySelectorAll('details[data-disclosure]')) {
    if (details.hasAttribute('data-pending-trace')) continue;
    const previous = disclosures.find(item => item.key === details.dataset.disclosure);
    if (previous) details.open = previous.open;
  }
  patchPendingNode(el, next);
  restoreSelection();
  for (const details of el.querySelectorAll('details[data-disclosure]')) {
    const previous = disclosures.find(item => item.key === details.dataset.disclosure);
    const box = details.querySelector('.thought-text');
    if (box && previous?.scroll !== undefined) box.scrollTop = previous.scroll;
  }
  if (focusKey) [...el.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  answerScroll.restore(main, answerScroll.following ? main.scrollHeight : scroll);
}

function chatList() {
  if (!state.chats.length) return h('p', { class: 'chat-list-empty muted' }, 'No chats yet. Your questions are saved here on this device.');
  return h(
    'ul',
    { class: 'chat-list' },
    state.chats.map((chat) =>
      h(
        'li',
        { class: `chat-row${chat.id === state.activeChatId ? ' current' : ''}` },
        h(
          'button',
          { class: 'chat-open', type: 'button', onclick: () => openChat(chat.id) },
          h('span', { class: 'chat-name', title: chat.title }, chatTitle(chat.title)),
          h('span', { class: 'meta' }, chatDate(chat.updatedAt)),
        ),
        h('button', { class: 'icon-button', type: 'button', title: 'Delete chat', 'aria-label': `Delete chat: ${chat.title}`, disabled: state.pending?.chatId === chat.id, onclick: () => deleteChat(chat.id) }, icon('delete')),
      ),
    ),
  );
}

function askBar() {
  const chat = activeChat();
  return h(
    'div',
    { class: 'ask-bar' },
    h('span', { class: 'chat-title', title: chat?.title }, state.showChats ? 'Chats' : chat ? chatTitle(chat.title) : 'New chat'),
    h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: 'Chats',
        'aria-label': 'Chats',
        'aria-pressed': String(state.showChats),
        onclick: () => ((state.showChats = !state.showChats), render()),
      },
      icon('chats'),
    ),
    h('button', { class: 'icon-button', type: 'button', title: 'New chat', 'aria-label': 'New chat', disabled: Boolean(state.pending), onclick: () => openChat(null) }, icon('new')),
  );
}

function coursePicker() {
  const choices = [{ id: '', label: 'All my courses' }, ...courses().map(course => ({ id: String(course.id), label: shortCourseLabel(course) }))];
  const selected = choices.find(choice => choice.id === state.askScope) ?? choices[0];
  const close = (restoreFocus = false) => {
    menu.hidePopover();
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus({ preventScroll: true });
  };
  const options = choices.map(choice => h('button', {
    type: 'button', role: 'option', 'aria-selected': String(choice.id === selected.id), tabindex: '-1',
    onclick: () => {
      state.askScope = choice.id;
      close();
      saveUi();
      render();
      document.querySelector('[data-focus-key="ask-scope"]')?.focus({ preventScroll: true });
    },
  }, h('span', { class: 'scope-check', 'aria-hidden': 'true' }, choice.id === selected.id ? '✓' : ''), choice.label));
  const menu = h('div', {
    id: 'ask-course-options', class: 'scope-options', popover: 'auto', role: 'listbox', 'aria-label': 'Course',
    ontoggle: event => button.setAttribute('aria-expanded', String(event.newState === 'open')),
    onkeydown: event => {
      const index = options.indexOf(document.activeElement);
      const target = { ArrowDown: Math.min(index + 1, options.length - 1), ArrowUp: Math.max(index - 1, 0), Home: 0, End: options.length - 1 }[event.key];
      if (target !== undefined) { event.preventDefault(); options[target].focus(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === 'Tab') close();
    },
  }, options);
  const open = () => {
    menu.showPopover();
    button.setAttribute('aria-expanded', 'true');
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.bottom = `${innerHeight - rect.top + 7}px`;
    menu.style.maxHeight = `${Math.max(40, Math.min(280, rect.top - 15))}px`;
    options[choices.indexOf(selected)].focus({ preventScroll: true });
    options[choices.indexOf(selected)].scrollIntoView({ block: 'nearest' });
  };
  const button = h('button', {
    class: 'scope-button', type: 'button', 'data-focus-key': 'ask-scope', 'aria-label': `Course: ${selected.label}`,
    'aria-haspopup': 'listbox', 'aria-controls': menu.id, 'aria-expanded': 'false',
    onclick: () => menu.matches(':popover-open') ? close() : open(),
    onkeydown: event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
      if (event.key === 'Escape' && menu.matches(':popover-open')) { event.preventDefault(); event.stopPropagation(); close(); }
    },
  }, h('span', null, selected.label), icon('chevron'));
  return h('div', { class: 'scope' }, button, menu);
}

function thinkingPicker() {
  const model = state.genai?.model;
  const levels = thinkingLevels(model);
  if (!levels.length) return null;
  const level = levels.includes(state.thinkingByModel[model]) ? state.thinkingByModel[model] : 'default';
  const value = h('span', null, thinkingLabel(level));
  const label = h('output', null, thinkingLabel(level));
  const slider = h('input', { type: 'range', min: 0, max: levels.length - 1, step: 1, value: levels.indexOf(level), disabled: Boolean(state.pending), 'aria-label': 'Thinking level', 'aria-valuetext': thinkingLabel(level),
    style: `--range-fill:${100 * levels.indexOf(level) / (levels.length - 1)}%`,
    oninput: event => {
      const selected = levels[Number(event.target.value)];
      value.textContent = label.textContent = thinkingLabel(selected);
      event.target.setAttribute('aria-valuetext', thinkingLabel(selected));
      event.target.style.setProperty('--range-fill', `${100 * Number(event.target.value) / (levels.length - 1)}%`);
    },
    onchange: event => { state.thinkingByModel[model] = levels[Number(event.target.value)]; saveUi(); },
  });
  const button = h('button', { type: 'button', class: 'thinking-trigger', title: 'Thinking level', 'aria-label': 'Thinking level', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', disabled: Boolean(state.pending), 'data-focus-key': 'thinking-picker' }, icon('sliders'), value);
  const menu = h('div', { class: 'thinking-options', popover: 'auto', role: 'dialog', 'aria-label': 'Thinking options',
    ontoggle: event => button.setAttribute('aria-expanded', String(event.newState === 'open')),
  }, h('label', null, 'Thinking', label), slider,
    h('div', { class: 'thinking-stops', 'aria-hidden': 'true' }, levels.map(level => h('span', null, thinkingLabel(level)))));
  button.addEventListener('click', () => {
    if (menu.matches(':popover-open')) return menu.hidePopover();
    menu.showPopover();
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 10)}px`;
    slider.focus({ preventScroll: true });
  });
  return h('div', { class: 'thinking-picker' }, button, menu);
}

function sendControl() {
  return state.pending
    ? h('button', { class: 'send', type: 'button', 'aria-label': 'Stop', title: 'Stop', onclick: () => state.abort?.abort() }, icon('stop'))
    : h('button', { class: 'send', type: 'submit', 'aria-label': 'Send', title: 'Send', disabled: !state.draft.trim() }, icon('send'));
}

function askView() {
  if (state.quizLocked) {
    return [h('section', { class: 'section' }, h('h2', { class: 'heading' }, 'Ask is off during quizzes'), h('p', { class: 'muted', style: 'margin-top:4px' }, 'A quiz attempt is open in this window. Ask comes back when you leave the quiz.'))];
  }
  if (!state.snapshot || !state.genai) return [setupView()];
  if (state.showChats) return h('div', { class: 'ask' }, askBar(), chatList());

  const textarea = h('textarea', {
    rows: 1,
    placeholder: state.askScope ? `Ask about ${labelFor(Number(state.askScope))}` : 'Ask about your courses',
    'aria-label': 'Question',
    value: state.draft,
    oninput: (e) => {
      state.draft = e.target.value;
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
      e.target.form.querySelector('.send').disabled = !state.draft.trim() && !state.pending;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendQuestion(state.draft);
      }
    },
  });
  const send = sendControl();
  textarea.dataset.focusKey = 'question';

  const messages = chatMessages();
  const pendingHere = state.pending?.chatId === state.activeChatId ? state.pending : null;
  const empty = messages.length === 0 && !pendingHere;
  const scope = coursePicker();
  return h(
    'div',
    { class: 'ask' },
    askBar(),
    h(
      'div',
      { class: 'messages', 'aria-label': 'Conversation',
        ...answerScroll.handlers(),
      },
      empty &&
        h(
          'div',
          { class: 'empty-chat' },
          h('h2', null, 'Ask about your courses'),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, `Search your syllabi, course files${state.discussions.sources.length ? ', and connected discussions' : ''}. Answers include source links.`),
          h('ul', { class: 'suggestions' }, SUGGESTED_QUESTIONS.map((q) => h('li', null, h('button', { type: 'button', onclick: () => sendQuestion(q) }, q)))),
        ),
      messages.map(messageView),
      pendingHere && pendingView(),
    ),
    h(
      'div',
      { class: 'composer' },
      h('form', { onsubmit: (e) => (e.preventDefault(), sendQuestion(state.draft)) }, textarea, h('div', { class: 'composer-tools' }, scope, thinkingPicker(), send)),
    ),
  );
}


// ---------- Settings ----------

async function refreshGradescope(force = false) {
  if (!state.gradescope || state.busy.gradescope || state.pending) return;
  state.busy.gradescope = true;
  try { await gradescopeRequest('sync', { force }); }
  catch (error) { state.gradescopeError = error.message; }
  finally { state.busy.gradescope = false; await loadState(); if (!state.pending) render(); }
}

async function openGradescopeAccess() {
  if (EMBEDDED) {
    try { await gradescopeRequest('open-access'); }
    catch (error) { state.gradescopeError = error.message; render(); }
    return;
  }
  // Request permission in the click handler, while the browser still has its gesture.
  const permission = chrome.permissions.request({ origins: GRADESCOPE_SITES });
  await connectGradescope(permission);
}

async function connectGradescope(permission = chrome.permissions.request({ origins: GRADESCOPE_SITES })) {
  if (state.busy.gradescope) return;
  state.busy.gradescope = true;
  state.gradescopeError = '';
  state.gradescopeAccessDone = false;
  render();
  try {
    if (!(await permission)) throw new Error('Allow Gradescope access to connect.');
    let signInTab = null;
    const until = Date.now() + 5 * 60_000;
    while (true) {
      try { await gradescopeRequest('connect'); break; }
      catch (error) {
        if (!error.needsReconnect || Date.now() > until) throw error;
        if (!signInTab) {
          const existing = (await chrome.tabs.query({ url: `${GRADESCOPE_ORIGIN}/*` }))[0];
          signInTab = existing ? await chrome.tabs.update(existing.id, { active: true }) : await chrome.tabs.create({ url: `${GRADESCOPE_ORIGIN}/account`, active: true });
        } else if (!(await chrome.tabs.get(signInTab.id).catch(() => null))) throw new Error('Sign-in was closed. Connect again when you are ready.', { cause: error });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    state.gradescopeAccessDone = true;
  } catch (error) { state.gradescopeError = error.message; }
  finally { state.busy.gradescope = false; await loadState(); render(); }
}

async function updateGradescope(action, args = {}) {
  try { await gradescopeRequest(action, args); }
  catch (error) { state.gradescopeError = error.message; }
  await loadState(); render();
}

function gradescopeCourseList(list, options = true) {
  return list.map(source => h('div', { class: 'discussion-source', 'data-source-id': source.id },
    h('h3', { class: 'small' }, link(source.url, source.name, { class: 'discussion-class-link' })),
    options && h('p', { class: 'connection-match' }, source.courseId ? `${labelFor(source.courseId)}${source.linkOrigin === 'manual' ? '' : ' · Matched automatically'}` : 'Available in Week and Ask'),
    h('p', { class: 'meta' }, `${plural(source.assignments?.length ?? 0, 'assignment')}${source.lastSyncedAt ? ` · Synced ${syncAge(source.lastSyncedAt)}` : ''}`),
    source.error && h('p', { class: 'error-text small' }, source.error),
    disclosure(`gradescope-assignments-${source.id}`, 'Assignments', h('ul', { class: 'list' }, (source.assignments ?? []).map(item => h('li', null,
      link(item.url, item.title),
      h('div', { class: 'meta' }, item.dueAt ? `Due ${formatDateTime(item.dueAt)}` : 'No due date published'),
      item.lateDueAt && h('div', { class: 'meta' }, `Late deadline ${formatDateTime(item.lateDueAt)}`),
    )))),
    options && disclosure(`gradescope-options-${source.id}`, 'Options', h('label', { class: 'field' }, 'Brightspace course', h('select', {
      'aria-label': `Brightspace course for ${source.name}`, disabled: state.busy.gradescope,
      onchange: event => updateGradescope('link', { sourceId: source.id, courseId: event.target.value ? Number(event.target.value) : null }),
    }, h('option', { value: '', selected: !source.courseId }, 'Keep as a separate course'), courses().map(course => h('option', { value: course.id, selected: source.courseId === course.id }, shortCourseLabel(course)))))),
  ));
}

function gradescopeSettings() {
  const data = state.gradescope;
  const failed = data?.status === 'error';
  const reconnect = data?.needsReconnect;
  const status = state.busy.gradescope ? 'Updating assignments…' : data ? `${plural(data.courses.length, 'course')} · ${failed ? reconnect ? 'Sign-in needed' : 'Update failed' : plural(gradescopeAssignments(data).length, 'assignment')}` : 'Assignments and due dates';
  return connectionCard('gradescope-details', 'gradescope', 'Gradescope', status, Boolean(data) && !failed, {
    action: (!data || failed) && h('button', { class: 'button secondary', type: 'button', disabled: state.busy.gradescope, 'aria-label': !data ? 'Connect Gradescope' : reconnect ? 'Reconnect Gradescope' : 'Retry Gradescope sync', onclick: () => data && !reconnect ? refreshGradescope(true) : openGradescopeAccess() }, !data ? 'Connect' : reconnect ? 'Reconnect' : 'Retry'),
    notices: [state.gradescopeError && h('p', { class: 'error-text small' }, state.gradescopeError)],
    children: [data && [
      gradescopeCourseList(data.courses),
      !data.courses.length && h('p', { class: 'meta' }, 'No current-term Gradescope courses found.'),
      h('div', { class: 'button-row' },
        h('button', { class: 'text-button', type: 'button', disabled: state.busy.gradescope, onclick: () => refreshGradescope(true) }, 'Sync assignments now'),
        h('button', { class: 'text-button danger-text', type: 'button', disabled: state.busy.gradescope, onclick: () => updateGradescope('disconnect') }, 'Disconnect Gradescope'),
      ),
      data.error && h('p', { class: 'error-text small' }, data.error),
    ]],
  });
}

function gradescopeAccessView() {
  return h('section', { class: 'setup' },
    h('h2', { class: 'setup-intro' }, state.gradescopeAccessDone ? 'Gradescope connected' : 'Connect Gradescope'),
    h('p', null, state.gradescopeAccessDone ? 'Your assignments are available in BoilerSpace.' : 'Allow access to read assignment names and dates from your signed-in account.'),
    state.gradescopeError && h('p', { class: 'error-text' }, state.gradescopeError),
    h('div', { class: 'button-row' }, state.gradescopeAccessDone
      ? h('button', { class: 'button', type: 'button', onclick: () => window.close() }, 'Return to BoilerSpace')
      : h('button', { class: 'button', type: 'button', disabled: state.busy.gradescope, onclick: () => connectGradescope() }, state.busy.gradescope ? 'Connecting…' : 'Allow Gradescope and connect')),
  );
}

function discussionProgress(source) {
  const count = plural(source.threads?.length ?? 0, 'saved post');
  if (source.status === 'syncing') return `${count} · Checking history (${source.checkedCount ?? 0} posts checked)…`;
  if (source.sync || !source.historyComplete) return `${count} · Import incomplete; the next sync resumes where it stopped.`;
  return `${count} · Full history checked${source.lastSyncedAt ? ` ${formatDateTime(source.lastSyncedAt)}` : ''}`;
}

function discussionSourceCard(source) {
  return h('div', { class: 'discussion-source', 'data-source-id': source.id },
    h('h3', { class: 'small' }, link(source.url, [source.name, h('span', { class: 'external-mark', 'aria-hidden': 'true' }, '↗')], { class: 'discussion-class-link', title: `Open ${source.name} in ${discussionName(source.platform)}` })),
    h('p', { class: 'connection-match' }, source.courseId ? [h('span', { class: 'status-dot' }), ` ${labelFor(source.courseId)}${source.linkOrigin === 'manual' ? '' : ' · Matched automatically'}`] : 'Available in Ask as a separate course'),
    h('p', { class: 'meta' }, discussionProgress(source)),
    source.error && h('p', { class: 'small error-text' }, source.error),
    source.warning && h('p', { class: 'small' }, source.warning),
    disclosure(`source-options-${source.id}`, 'Options', h('label', { class: 'field' }, 'Brightspace course', h('select', { 'aria-label': 'Brightspace course', 'data-focus-key': `course-${source.id}`, onchange: (event) => updateDiscussion('link', source.id, event.target.value ? Number(event.target.value) : null) },
      h('option', { value: '', selected: !source.courseId }, 'Keep as a separate discussion course'),
      courses().map((course) => h('option', { value: course.id, selected: source.courseId === course.id }, shortCourseLabel(course))),
    )), h('div', { class: 'source-danger-action' }, h('button', { type: 'button', class: 'text-button danger-text', disabled: state.busy.discussions, onclick: () => updateDiscussion('remove', source.id) }, 'Disconnect class'))),
  );
}

function connectionHeader(service, name, status, connected) {
  return h('div', { class: 'connection-header' },
    h('span', { class: `service-icon service-${service}`, 'aria-hidden': 'true' }, service === 'brightspace' ? h('img', { src: chrome.runtime.getURL('icons/icon48.png'), width: 23, height: 23, alt: '' }) : { ed: 'ed', piazza: 'P', genai: 'AI', gradescope: 'G' }[service]),
    h('div', { class: 'connection-info' }, h('h3', null, name), h('p', { class: 'connection-status' }, status)),
    connected && h('span', { class: 'status-dot', role: 'img', 'aria-label': 'Connected' }),
    icon('chevron'),
  );
}

function connectionCard(key, service, name, status, connected, { action, notices = [], children = [] } = {}) {
  const details = disclosure(key, connectionHeader(service, name, status, connected), h('div', { class: 'connection-body' }, children));
  details.classList.add('connection-details');
  return h('article', { class: `settings-group connection-card${action ? ' needs-action' : ''}`, 'data-platform': service },
    details,
    action && h('div', { class: 'connection-action' }, action),
    notices,
  );
}

function discussionConnection(platform) {
  const name = discussionName(platform);
  const sources = state.discussions.sources.filter(source => source.platform === platform);
  const connected = sources.length > 0;
  const connecting = state.busy.discussionConnect && state.discussionPlatform === platform;
  const reading = sources.some(source => source.status === 'syncing');
  const problem = sources.some(source => source.error);
  const authProblem = sources.some(source => source.error && source.needsReconnect !== false);
  const posts = sources.reduce((total, source) => total + (source.threads?.length ?? 0), 0);
  const status = connecting ? 'Connecting…' : connected ? `${plural(sources.length, 'course')} · ${reading ? 'Reading posts…' : problem ? (authProblem ? 'Sign-in needed' : 'Update failed') : plural(posts, 'post')}` : platform === 'ed' ? 'Use your signed-in Ed account' : 'Use your signed-in Piazza account';
  const retry = connected && problem && !authProblem;
  const button = (!connected || problem) && h('button', { class: 'button secondary', type: 'button', disabled: state.busy.discussionConnect, onclick: () => retry ? refreshDiscussions(true) : openDiscussionAccess(platform, authProblem && platform === 'piazza' ? sources.find(source => source.error).url : null), 'aria-label': retry ? `Retry ${name} sync` : `${problem ? 'Reconnect' : 'Connect'} ${name}` }, connecting ? 'Connecting…' : retry ? 'Retry' : problem ? 'Reconnect' : 'Connect');
  const classLink = platform === 'piazza' && disclosure('piazza-link', 'Add a class by link',
    h('form', { class: 'class-link-form', onsubmit: event => { event.preventDefault(); openDiscussionAccess('piazza'); } },
      h('label', { class: 'field' }, 'Piazza class URL', h('input', { type: 'url', required: true, 'data-focus-key': 'piazza-url', value: state.piazzaUrl, placeholder: 'https://piazza.com/class/…', oninput: event => { state.piazzaUrl = event.target.value; } })),
      h('button', { class: 'button secondary', type: 'submit', disabled: state.busy.discussionConnect }, 'Add class'),
    ),
  );
  return connectionCard(`manage-${platform}`, platform, name, status, connected && !problem, {
    action: button,
    notices: [
      state.discussionPlatform === platform && state.discussionError && h('p', { class: 'connection-error error-text', role: 'alert' }, state.discussionError),
      connecting && h('p', { class: 'connection-progress', role: 'status' }, state.discussionConnecting),
      !connected && classLink,
    ],
    children: [connected && [
      sources.map(discussionSourceCard),
      h('div', { class: 'platform-actions' }, h('button', { class: 'text-button', type: 'button', disabled: state.busy.discussionConnect, onclick: () => openDiscussionAccess(platform) }, 'Find more courses')),
    ], connected && classLink, !connected && h('p', { class: 'meta' }, `Connect ${name} to search its course discussions.`)],
  });
}

function discussionsSettings() {
  return h('section', { class: 'connection-section', id: 'discussions' },
    discussionConnection('ed'), discussionConnection('piazza'),
    state.discussions.sources.length > 0 && h('div', { class: 'connection-actions' }, h('button', { type: 'button', class: 'text-button', disabled: state.busy.discussions, onclick: () => refreshDiscussions(true) }, state.busy.discussions ? 'Syncing discussions…' : 'Sync discussions now')),
  );
}

function discussionAccessView() {
  const name = discussionName(DISCUSSION_ACCESS);
  return [h('section', { class: 'setup' },
    h('h2', { class: 'setup-intro' }, state.discussionAccessDone ? `${name} connected` : `Connect ${name}`),
    h('p', null, state.discussionAccessDone ? 'Your posts are being added in the background. You can return to BoilerSpace.' : 'Allow access and sign in if needed. Your courses are found and matched automatically.'),
    h('p', { class: 'meta', style: 'margin-top:12px' }, 'Relevant post text goes to Purdue GenAI Studio when you ask. BoilerSpace reads public text and replies; it does not post or reply.'),
    state.discussionError && h('p', { class: 'error-text' }, state.discussionError),
    state.discussionConnecting && h('p', { class: 'connection-progress', role: 'status' }, state.discussionConnecting),
    !state.discussionAccessDone && h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'button', disabled: state.busy.discussionConnect, onclick: () => connectDiscussions() }, state.busy.discussionConnect ? 'Connecting…' : `Allow ${name} and connect`)),
    state.discussionAccessDone && h('div', { class: 'button-row' }, h('button', { class: 'button', type: 'button', onclick: () => window.close() }, 'Return to BoilerSpace')),
    (state.busy.discussions || state.discussionAccessDone) && state.discussions.sources.filter((s) => s.platform === DISCUSSION_ACCESS).map((s) => h('p', { class: s.error ? 'small error-text' : 'small', style: 'margin-top:12px' }, `${s.name}: ${s.error || discussionProgress(s)}`)),
  )];
}

function modelField() {
  const models = state.genai.models?.length ? state.genai.models : [state.genai.model];
  if (!state.modelsLoaded) {
    state.modelsLoaded = true;
    refreshModels()
      .then(() => loadState())
      .then(() => state.view === 'settings' && render())
      .catch(error => {
        state.genaiError = error.message;
        if (state.view === 'settings') render();
      });
  }
  return h(
    'label',
    { class: 'field' },
    'Model',
    h(
      'select',
      {
        'data-focus-key': 'model',
        onchange: async (e) => {
          await setModel(e.target.value);
          await loadState();
          render();
        },
      },
      models.map((m) => h('option', { value: m, selected: m === state.genai.model }, m === DEFAULT_MODEL ? `${m} (recommended)` : m)),
    ),
    h('span', { class: 'meta' }, 'Used for reading syllabi and answering questions. Larger models are slower.'),
  );
}

function applyTheme(preference = state.theme) {
  state.theme = THEMES.includes(preference) ? preference : 'system';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.colorScheme = state.theme === 'system' ? (systemColorScheme.matches ? 'dark' : 'light') : state.theme;
  for (const input of document.querySelectorAll('.theme-options input')) input.checked = input.value === state.theme;
}

function themeSetting() {
  return h('section', { class: 'settings-group' },
    h('div', { class: 'theme-row' },
      h('h2', { class: 'heading', id: 'theme-label' }, 'Theme'),
      h('div', { class: 'theme-options', role: 'radiogroup', 'aria-labelledby': 'theme-label' }, THEMES.map(theme =>
        h('label', { class: 'theme-option' },
          h('input', { type: 'radio', name: 'theme', value: theme, checked: state.theme === theme, onchange: async () => {
            applyTheme(theme);
            try { await store.set(store.KEYS.theme, theme); }
            catch (error) { setStatus(`Could not save theme: ${error.message}`); }
          } }),
          h('span', null, theme[0].toUpperCase() + theme.slice(1)),
        ),
      )),
    ),
  );
}

function settingsView() {
  const meta = state.syncMeta;
  const errors = meta?.errors ?? [];
  const connected = Boolean(state.genai);
  return [
    viewHeading('Connections'),
    hostAccessNotice(),
    connectionCard('brightspace-details', 'brightspace', 'Brightspace', state.snapshot ? `${plural(courses().length, 'course')} · ${meta?.lastSuccessAt ? `Synced ${syncAge(meta.lastSuccessAt)}` : 'Not synced yet'}` : 'Your courses and deadlines', Boolean(state.snapshot), {
      action: !state.snapshot && h('button', { class: 'button secondary', type: 'button', disabled: state.busy.sync, onclick: runSync }, state.busy.sync ? 'Loading…' : 'Connect'),
      notices: [syncFailure() && h('p', { class: 'small error-text' }, syncFailure())],
      children: [
        h('p', { class: 'meta', style: 'margin-top:10px' }, meta?.lastSuccessAt ? `Last updated ${formatDateTime(meta.lastSuccessAt)}. Refreshes while you use Brightspace.` : 'Sign in to Brightspace in this browser to load your courses.'),
        errors.length > 0 && h('ul', { class: 'error-list' }, errors.map(error => h('li', null, `${error.courseId ? labelFor(error.courseId) : ''} ${error.section}: ${error.message}`))),
        h('div', { class: 'button-row' }, h('button', { class: 'button secondary', type: 'button', disabled: state.busy.sync, onclick: runSync }, state.busy.sync ? 'Syncing…' : 'Sync now')),
      ],
    }),
    connectionCard('genai-details', 'genai', 'Purdue GenAI Studio', state.genaiError ? 'Connection needs attention' : connected ? 'Connected' : 'Course answers, with your Purdue account', connected && !state.genaiError, {
      action: (!connected || state.genaiError) && h('button', { class: 'button secondary', type: 'button', 'aria-label': `${state.genaiError ? 'Reconnect' : 'Connect'} Purdue GenAI Studio`, disabled: state.busy.link, onclick: connectGenAI }, state.busy.link ? 'Connecting…' : state.genaiError ? 'Reconnect' : 'Connect'),
      notices: [
        state.linkStatus && h('p', { class: 'connection-progress', role: 'status' }, state.linkStatus),
        state.linkError && h('p', { class: 'small error-text', role: 'alert' }, state.linkError),
      ],
      children: [connected && [
        state.genaiError && h('p', { class: 'small error-text' }, state.genaiError),
        h('p', { class: 'meta', style: 'margin-top:10px' }, `Connected as ${state.genai.name}.`),
        modelField(),
        h('div', { class: 'button-row' }, h('button', { class: 'text-button', type: 'button', onclick: async () => { await unlink(); await loadState(); render(); } }, 'Disconnect GenAI Studio')),
        h('p', { class: 'meta', style: 'margin-top:8px' }, 'Disconnect removes the saved key from this browser. You can revoke it in GenAI Studio under Settings, Account.'),
      ]],
    }),
    gradescopeSettings(),
    discussionsSettings(),
    h('p', { class: 'connections-note' }, 'Discussions update every 20 minutes while BoilerSpace is open.'),
    themeSetting(),
    h('section', { class: 'settings-group' },
      h('div', { class: 'calendar-row' }, h('h2', { class: 'heading' }, 'Calendar'), h('button', { class: 'text-button', type: 'button', disabled: !state.snapshot, onclick: exportCalendar }, 'Export calendar (.ics)')),
    ),
    h('section', { class: 'settings-group advanced-settings' },
      disclosure('advanced-settings', 'Advanced',
        h('div', { class: 'button-row' },
          h('button', { class: 'text-button', type: 'button', disabled: !state.snapshot, onclick: exportData }, 'Export data'),
          h('button', { class: 'text-button danger-text', type: 'button', onclick: clearData }, 'Clear local data'),
        ),
        disclosure('benchmark-tools', 'Developer tools',
          h('div', { class: 'button-row' }, h('button', { class: 'text-button', type: 'button', disabled: !state.snapshot || state.busy.capture, onclick: saveBenchmarkData }, state.busy.capture ? 'Saving…' : 'Export benchmark data')),
        ),
      ),
      link('https://github.com/ltmerletti/BoilerSpace/blob/main/PRIVACY.md', 'Privacy', { class: 'privacy-link' }),
    ),
  ];
}


// ---------- Connect page (opened from the panel inside Brightspace) ----------

function connectPageView() {
  if (state.genai && !state.busy.link) {
    return [h('section', { class: 'setup' }, h('h2', { class: 'setup-intro' }, 'GenAI Studio is connected.'), h('p', null, 'You can close this tab and go back to Brightspace.'))];
  }
  return [
    h(
      'section',
      { class: 'setup' },
      h('h2', { class: 'setup-intro' }, 'Connect Purdue GenAI Studio'),
      h('p', null, state.linkStatus || 'Sign in with your Purdue account when GenAI Studio opens. BoilerSpace continues on its own.'),
      state.linkError && h('p', { class: 'error-text', style: 'margin-top:8px' }, state.linkError),
      !state.busy.link && h('div', { class: 'button-row' }, h('button', { class: 'button', type: 'button', onclick: linkHere }, state.linkError ? 'Try again' : 'Connect')),
    ),
  ];
}

// ---------- Rendering ----------

function syncAge(at) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : formatDateTime(at);
}

function syncLine() {
  if (state.busy.sync && (!state.snapshot || (state.runningSync && !state.quietSync))) return 'Syncing';
  const meta = state.syncMeta;
  if (!meta?.lastSuccessAt) return '';
  return state.busy.syllabi ? 'Reading syllabi…' : `Synced ${syncAge(meta.lastSuccessAt)}`;
}

const VIEWS = { week: weekView, courses: coursesView, ask: askView, settings: settingsView };
const expandedSections = new Map();
let mountedAsk = null;

function askCanStayMounted() {
  return state.view === 'ask' && !state.showChats && state.snapshot && state.genai && !state.quizLocked
    && !CONNECT_PAGE && !ACCESS_PAGE && !DISCUSSION_ACCESS && !GRADESCOPE_ACCESS;
}

function askRegionKeys() {
  return {
    scope: JSON.stringify([state.askScope, courses().map(course => [course.id, shortCourseLabel(course)])]),
    thinking: JSON.stringify([state.genai?.model, Boolean(state.pending)]),
    notices: JSON.stringify([state.syllabusAccess, state.hostAccess, Object.values(state.syllabi).some(record => isSyllabusAccessError(record?.error))]),
    empty: Boolean(state.discussions.sources.length),
  };
}

function rememberAskMount(main) {
  mountedAsk = askCanStayMounted() ? {
    root: main.querySelector('.ask'), chatId: state.activeChatId, epoch: state.dataEpoch,
    keys: askRegionKeys(), pending: Boolean(state.pending),
  } : null;
}

function finishPendingNode(node, next) {
  const body = node.querySelector('.streaming-answer');
  if (body) {
    const blocks = [...next.children].filter(child => child.dataset.selectionKey);
    patchPendingNode(body, h('div', { class: 'streaming-answer' }, blocks));
    // Retain the streamed paragraphs when removing their temporary wrapper.
    const footer = next.querySelector('.answer-footer');
    for (const block of [...body.childNodes]) next.insertBefore(block, footer);
  }
  for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
  for (const attribute of next.attributes) node.setAttribute(attribute.name, attribute.value);
  node.replaceChildren(...next.childNodes);
}

function updateAskMessages(list) {
  const messages = chatMessages();
  const existing = new Map([...list.children].filter(node => node.dataset.messageKey).map(node => [node.dataset.messageKey, node]));
  const desired = [];
  messages.forEach((message, index) => {
    const key = messageKey(message, index), signature = chatSignature(message);
    let node = existing.get(key);
    if (!node || messageSnapshots.get(node) !== signature) {
      const next = messageView(message, index);
      if (node?.id === 'pending') {
        finishPendingNode(node, next);
        messageSnapshots.set(node, signature);
      } else node = next;
    }
    if (message.role === 'assistant') {
      const latest = index === messages.length - 1;
      let actions = node.querySelector('.message-actions');
      if (!latest) actions?.remove();
      else {
        if (!actions) {
          actions = savedMessageView(message, index).querySelector('.message-actions');
          (node.querySelector('.answer-footer') ?? node).append(actions);
        }
        for (const button of actions.querySelectorAll('button')) {
          if (button.getAttribute('aria-label') !== 'Copy answer' && button.getAttribute('aria-label') !== 'Copied') button.disabled = Boolean(state.pending);
        }
      }
    }
    desired.push(node);
  });
  const pending = state.pending?.chatId === state.activeChatId ? state.pending : null;
  if (pending) desired.push(existing.get(pending.runId) ?? pendingView());
  if (!desired.length) {
    let empty = list.querySelector('.empty-chat');
    if (!empty || mountedAsk.keys.empty !== Boolean(state.discussions.sources.length)) empty = askView().querySelector('.empty-chat');
    desired.push(empty);
  }
  desired.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null); });
  for (const node of [...list.children]) if (!desired.includes(node)) node.remove();
}

function updateMountedAsk() {
  if (!askCanStayMounted() || !mountedAsk?.root.isConnected || mountedAsk.chatId !== state.activeChatId || mountedAsk.epoch !== state.dataEpoch) return false;
  const root = mountedAsk.root, keys = askRegionKeys();
  if (keys.notices !== mountedAsk.keys.notices) {
    for (const notice of [...root.parentElement.children]) if (notice !== root) notice.remove();
    for (const notice of [syllabusAccessNotice(), hostAccessNotice()].filter(Boolean)) root.before(notice);
  }
  const replaceControl = (selector, make) => {
    const previous = root.querySelector(selector), next = make();
    const focused = previous?.contains(document.activeElement);
    if (previous) next ? previous.replaceWith(next) : previous.remove();
    else if (next) root.querySelector('.composer-tools .send').before(next);
    if (focused) next?.querySelector('[data-focus-key]')?.focus({ preventScroll: true });
  };
  if (keys.scope !== mountedAsk.keys.scope) replaceControl('.scope', coursePicker);
  if (keys.thinking !== mountedAsk.keys.thinking) replaceControl('.thinking-picker', thinkingPicker);
  const pending = Boolean(state.pending);
  if (pending !== mountedAsk.pending) root.querySelector('.composer .send').replaceWith(sendControl());
  root.querySelector('.ask-bar button[aria-label="New chat"]').disabled = pending;
  const title = root.querySelector('.chat-title'), chat = activeChat();
  const text = chat ? chatTitle(chat.title) : 'New chat';
  if (title.textContent !== text) title.textContent = text;
  if (chat) title.title = chat.title;
  const input = root.querySelector('.composer textarea');
  input.placeholder = state.askScope ? `Ask about ${labelFor(Number(state.askScope))}` : 'Ask about your courses';
  if (input.value !== state.draft) {
    input.value = state.draft;
    input.style.height = 'auto';
    if (input.value) input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }
  root.querySelector('.composer .send').disabled = !pending && !state.draft.trim();
  updateAskMessages(root.querySelector('.messages'));
  mountedAsk.keys = keys;
  mountedAsk.pending = pending;
  return true;
}

function render({ top = false, bottom = false } = {}) {
  if (state.view === 'ask' && (top || bottom)) answerScroll.reset();
  const main = document.getElementById('view');
  const restoreSelection = rememberTextSelection(main);
  rememberPendingDisclosure();
  const scroller = main.querySelector('.messages') ?? main;
  const scroll = scroller.scrollTop;
  const active = document.activeElement;
  const focusKey = active?.dataset.focusKey;
  const selection = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  // Pending openness lives in state; copying its old DOM value at completion
  // would override the final answer's decision to fold the work log.
  for (const details of main.querySelectorAll('details[data-disclosure]')) {
    if (!details.hasAttribute('data-pending-trace')) expandedSections.set(details.dataset.disclosure, details.open);
  }
  const stable = updateMountedAsk();
  if (!stable) {
    const content = GRADESCOPE_ACCESS ? gradescopeAccessView() : DISCUSSION_ACCESS ? discussionAccessView() : ACCESS_PAGE ? syllabusAccessPage() : CONNECT_PAGE ? connectPageView() : [syllabusAccessNotice(), state.view === 'settings' ? null : hostAccessNotice(), VIEWS[state.view]()];
    main.replaceChildren(h('div', { class: state.view === 'ask' && !CONNECT_PAGE ? 'view ask-view' : 'view' }, content));
    rememberAskMount(main);
  }
  for (const details of main.querySelectorAll('details[data-disclosure]')) {
    if (!details.hasAttribute('data-pending-trace')) details.open = expandedSections.get(details.dataset.disclosure) ?? false;
  }
  const focused = focusKey && [...main.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey);
  if (focused && focused !== active) {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  } else if (top && state.view === 'ask') main.querySelector('textarea')?.focus({ preventScroll: true });
  const textarea = main.querySelector('.composer textarea');
  if (!stable && textarea?.value) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`; }
  restoreSelection();
  const nextScroller = main.querySelector('.messages') ?? main;
  if (state.view === 'ask') answerScroll.restore(nextScroller, top || bottom || answerScroll.following ? nextScroller.scrollHeight : scroll);
  else nextScroller.scrollTop = top ? 0 : scroll;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.toggleAttribute('aria-current', false);
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
  }
  renderHeader();
  renderStatus();
}

function renderConnectionReminder() {
  const reminder = document.getElementById('connection-reminder');
  const platforms = ['ed', 'piazza'].filter(platform => state.discussions.sources.some(source =>
    source.platform === platform && source.needsReconnect === true && source.status !== 'done'));
  if (state.gradescope?.needsReconnect) platforms.push('gradescope');
  const connectionName = platform => platform === 'gradescope' ? 'Gradescope' : discussionName(platform);
  const show = platforms.length > 0 && !CONNECT_PAGE && !ACCESS_PAGE && !DISCUSSION_ACCESS && !GRADESCOPE_ACCESS;
  reminder.hidden = !show;
  const key = JSON.stringify([show && platforms, state.busy.discussionConnect, state.discussionPlatform, state.busy.gradescope]);
  // Keep the buttons attached while streaming or unrelated sync progress arrives.
  if (reminder.dataset.state === key) return;
  reminder.dataset.state = key;
  if (!show) { reminder.replaceChildren(); return; }
  const names = platforms.map(connectionName);
  reminder.replaceChildren(
    h('span', null, `${names.join(' and ')} ${names.length === 1 ? 'needs' : 'need'} to reconnect`),
    h('div', { class: 'reminder-actions' }, platforms.map(platform => h('button', {
      type: 'button', class: 'text-button reminder-action',
      'aria-label': `Reconnect ${connectionName(platform)} connection`,
      disabled: state.busy.discussionConnect || state.busy.gradescope,
      onclick: () => platform === 'gradescope' ? openGradescopeAccess() : openDiscussionAccess(platform, platform === 'piazza' ? state.discussions.sources.find(source => source.platform === platform && source.needsReconnect)?.url : null),
    }, (state.busy.discussionConnect && state.discussionPlatform === platform) || (state.busy.gradescope && platform === 'gradescope') ? 'Connecting…' : platforms.length === 1 ? 'Reconnect' : connectionName(platform)))),
  );
}

function renderHeader() {
  renderConnectionReminder();
  document.getElementById('sync-status').textContent = syncLine();
  const syncButton = document.getElementById('sync-button');
  syncButton.disabled = state.busy.sync;
  syncButton.classList.toggle('spinning', state.busy.sync && (!state.snapshot || (state.runningSync && !state.quietSync)));
  syncButton.hidden = !state.snapshot || CONNECT_PAGE || ACCESS_PAGE || DISCUSSION_ACCESS || GRADESCOPE_ACCESS;
}

// Progress updates arrive several times a second during a sync, so they skip the full re-render.
function onSyncActivity() {
  const busy = computeSyncBusy();
  if (busy !== state.busy.sync && !state.snapshot) {
    state.busy.sync = busy;
    render();
  } else {
    state.busy.sync = busy;
    renderHeader();
    renderStatus();
    const syllabusStatus = document.getElementById('syllabus-sync-status');
    if (syllabusStatus) syllabusStatus.textContent = syllabusSyncLine();
  }
}

async function updateQuizLock() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const locked = Boolean(tab?.url?.startsWith(BRIGHTSPACE_ORIGIN) && tab.url.includes(QUIZ_ATTEMPT_PATH));
  if (locked !== state.quizLocked) {
    state.quizLocked = locked;
    if (state.view === 'ask') render();
  }
}

// Each optional piece is guarded so one missing API (extension frames in Firefox lack some) can't leave the panel half-loaded.
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn('BoilerSpace:', err);
    return undefined;
  }
}

async function init() {
  systemColorScheme.addEventListener('change', () => { if (state.theme === 'system') applyTheme(); });
  if (CONNECT_PAGE || ACCESS_PAGE || DISCUSSION_ACCESS || GRADESCOPE_ACCESS) document.querySelector('.tabs').hidden = true;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.addEventListener('click', () => {
      if (state.view === 'ask' && button.dataset.view === 'ask') state.showChats = false;
      state.view = button.dataset.view;
      if (state.view !== 'courses') state.courseId = null;
      saveUi();
      render({ top: true });
    });
  }
  document.getElementById('sync-button').addEventListener('click', runSync);
  if (EMBEDDED) {
    const closePanel = () => window.parent.postMessage(JSON.stringify({ type: 'boilerspace-close' }), BRIGHTSPACE_ORIGIN);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !e.target.closest?.('textarea, select, input') && closePanel());
  }

  await loadState({ includeChat: true });
  render();
  document.documentElement.removeAttribute('data-panel-loading');

  window.addEventListener('online', () => {
    if (state.gradescope?.status === 'error') refreshGradescope(true);
    if (state.discussions.sources.some(source => source.status === 'error' || source.sync)) {
      discussionRecoveryQueued = true;
      refreshDiscussions();
    }
  });

  store.onChange(async (changes) => {
    const keys = Object.keys(changes);
    if (changes[DATA_EPOCH_KEY]) {
      state.abort?.abort();
      state.pending = null;
      state.abort = null;
      queuedSyllabusRun = null;
      await loadState({ includeChat: true });
      render();
      return;
    }
    if (changes.genai && !changes.genai.newValue) state.abort?.abort();
    if (changes.theme) applyTheme(changes.theme.newValue ?? 'system');
    if (changes.chats && !state.pending) {
      const chats = changes.chats.newValue ?? [];
      if (chatSignature(chats) !== chatSignature(state.chats)) {
        state.chats = chats;
        if (!chats.some((c) => c.id === state.activeChatId)) state.activeChatId = null;
        if (state.view === 'ask') render();
      }
    }
    if (keys.every((k) => ['chat', 'chats', 'ui', 'drawerOpen', 'drawerWidth', 'theme', 'genaiLinkAttempt'].includes(k))) return;
    if (keys.every((k) => ['syncLock', 'syncProgress'].includes(k))) {
      if (changes.syncLock) state.syncLock = changes.syncLock.newValue ?? null;
      if (changes.syncProgress) state.progress = changes.syncProgress.newValue ?? null;
      onSyncActivity();
      return;
    }
    const accessGranted = changes.syllabusAccess?.newValue === true && changes.syllabusAccess.oldValue !== true;
    const snapshotChanged = keys.includes('snapshot');
    const linked = keys.includes('genai') && !changes.genai.oldValue && changes.genai.newValue;
    const newDiscussion = changes.discussions?.newValue?.sources?.some(source => !changes.discussions.oldValue?.sources?.some(previous => previous.id === source.id));
    await loadState();
    if (!state.pending || state.view === 'ask') render();
    if (CONNECT_PAGE && linked) setTimeout(() => window.close(), 1500);
    if (!ACCESS_PAGE && !CONNECT_PAGE && !DISCUSSION_ACCESS && !GRADESCOPE_ACCESS && (snapshotChanged || linked || accessGranted)) processSyllabi();
    if (!GRADESCOPE_ACCESS && !DISCUSSION_ACCESS && (snapshotChanged || (newDiscussion && !state.busy.discussionConnect))) refreshDiscussions();
    if (snapshotChanged && !GRADESCOPE_ACCESS) refreshGradescope();
  });
  if (DISCUSSION_ACCESS || GRADESCOPE_ACCESS) return;
  setInterval(onSyncActivity, 3000);

  const access = await attempt(() => chrome.runtime.sendMessage({ type: 'boilerspace-syllabus-access' }));
  if (access?.ok) { state.syllabusAccess = access.granted; render(); }
  if (ACCESS_PAGE) return;

  if (CONNECT_PAGE) {
    if (!state.genai && (await linkHere())) setTimeout(() => window.close(), 1500);
    return;
  }

  if (!EMBEDDED && chrome.tabs?.onActivated) {
    await attempt(() => {
      chrome.tabs.onActivated.addListener(updateQuizLock);
      chrome.tabs.onUpdated.addListener((_, info) => info.url && updateQuizLock());
      return updateQuizLock();
    });
  }
  if (!EMBEDDED) {
    state.hostAccess = (await attempt(() => chrome.permissions.contains({ origins: HOST_ORIGINS }))) ?? true;
    render();
  }

  // Sync on open if Brightspace is reachable; otherwise wait for the student to ask.
  const syncAge = state.syncMeta?.lastSuccessAt ? Date.now() - Date.parse(state.syncMeta.lastSuccessAt) : Infinity;
  if (syncAge > AUTO_SYNC_INTERVAL_MS && (await attempt(canReachBrightspace))) runSync({ quiet: true });
  else if (courses().some(course => !state.syllabi[course.id])) processSyllabi();
  refreshDiscussions();
  refreshGradescope();
  setInterval(() => { if (document.visibilityState === 'visible') refreshGradescope(); }, 20 * 60_000);
  setInterval(() => { if (document.visibilityState === 'visible') refreshDiscussions(); }, 20 * 60_000);
}

init().catch(error => {
  document.documentElement.removeAttribute('data-panel-loading');
  const status = document.getElementById('status');
  status.hidden = false;
  status.classList.add('error-text');
  status.textContent = error.code === 'background-unavailable'
    ? `BoilerSpace’s background did not respond. ${error.message}`
    : `BoilerSpace could not load saved data. ${error.message}`;
});
