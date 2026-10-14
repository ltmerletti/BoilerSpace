import * as store from './lib/store.js';
import { BRIGHTSPACE_ORIGIN, canReachBrightspace, connectParentPage, syncNow } from './lib/sync.js';
import { lockIsFresh } from './lib/sync-store.js';
import { DEFAULT_MODEL, getConnection, linkAccount, refreshModels, setModel, unlink } from './lib/genai.js';
import { choosableFiles, chooseSyllabus, pendingReviews, processCourse, readUploadedSyllabus, usableRecord } from './lib/syllabus.js';
import { agendaItems, aiPolicyFor, calendarEvents, courseTitle, currentCourses, groupByDay, itemDayKey, shortCourseLabel } from './lib/planner.js';
import { buildCalendar } from './lib/ics.js';
import { locationUrl, syllabusFile } from './lib/links.js';
import { ask, SUGGESTED_QUESTIONS } from './lib/agent.js';
import { captureBenchmark } from './lib/capture.js';
import { addDaysToKey, dayKey, daysBetweenKeys, formatDateTime, formatDayKey, formatTime, relativeDay } from './lib/dates.js';

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
const QUIZ_ATTEMPT_PATH = '/d2l/lms/quizzing/user/attempt/';
const HOST_ORIGINS = ['https://purdue.brightspace.com/*', 'https://genai.rcac.purdue.edu/*'];
const PARAMS = new URLSearchParams(location.search);
const EMBEDDED = PARAMS.has('embedded');
const CONNECT_PAGE = PARAMS.has('connect');
const STOPPED_SYNC_NOTICE_MS = 10 * 60_000;
const SYNC_ON_OPEN_AFTER_MS = 10 * 60_000;

if (EMBEDDED) connectParentPage();

const STANCE_LABEL = {
  allowed: 'AI allowed',
  restricted: 'AI allowed with limits',
  prohibited: 'No AI',
  unclear: 'AI policy not stated',
};

const STANCE_SENTENCE = {
  allowed: 'AI tools are allowed',
  restricted: 'AI tools are allowed with limits',
  prohibited: 'AI tools are not allowed',
  unclear: 'The syllabus does not say whether AI tools are allowed',
};

const state = {
  view: 'week',
  courseId: null,
  snapshot: null,
  syncMeta: null,
  changes: [],
  genai: null,
  syllabi: {},
  reviews: {},
  chats: [],
  activeChatId: null,
  showChats: false,
  openTraces: new Set(),
  askScope: '',
  draft: '',
  pending: null,
  abort: null,
  quizLocked: false,
  hostAccess: true,
  syncLock: null,
  progress: null,
  runningSync: false,
  status: '',
  busy: { sync: false, syllabi: false, link: false, capture: false },
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

const chatTitle = (text) => {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
};

// Chats used to be one list under "chat"; keep it as the first session.
async function loadChats(all) {
  if (all.chats || !all.chat?.length) return all.chats ?? [];
  const at = new Date().toISOString();
  const first = all.chat.find((m) => m.role === 'user');
  const chats = [{ id: crypto.randomUUID(), title: chatTitle(first?.content ?? 'Earlier chat'), createdAt: at, updatedAt: at, messages: all.chat }];
  await store.set(store.KEYS.chats, chats);
  await store.remove(store.KEYS.chat);
  return chats;
}

async function loadState({ includeChat = false } = {}) {
  const all = await store.getAll();
  if (includeChat) {
    state.chats = await loadChats(all);
    const ui = all.ui ?? {};
    if (VIEW_NAMES.includes(ui.view)) state.view = ui.view;
    state.courseId = ui.courseId ?? null;
    state.askScope = ui.askScope ?? '';
    state.activeChatId = state.chats.some((c) => c.id === ui.activeChatId) ? ui.activeChatId : null;
  }
  state.snapshot = all.snapshot ?? null;
  state.syncMeta = all.syncMeta ?? null;
  state.changes = all.changes ?? [];
  state.genai = all.genai ? await getConnection() : null;
  state.syllabi = all.syllabi ?? {};
  state.reviews = all.reviews ?? {};
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
  } else if (!text && p && !p.finished && Date.now() - p.at < STOPPED_SYNC_NOTICE_MS) {
    text = 'The last sync stopped partway, probably because the Brightspace page changed. It tries again on the next page, or press sync.';
  }
  el.hidden = !text;
  el.replaceChildren(
    h('span', null, text),
    bar && h('div', { class: `progress${fraction === null ? ' indeterminate' : ''}` }, h('div', { class: 'progress-fill', style: fraction === null ? null : `width:${Math.round(fraction * 100)}%` })),
  );
}

// ---------- Actions ----------

async function runSync() {
  if (state.busy.sync) return;
  state.runningSync = true;
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
  }
}

let queuedSyllabusRun = null;

async function processSyllabi(options = {}) {
  if (!state.genai || !state.snapshot) return;
  if (state.busy.syllabi) {
    if (options.force) queuedSyllabusRun = options;
    return;
  }
  const { force = false, courseId = null } = options;
  state.busy.syllabi = true;
  render();
  try {
    for (const course of courses()) {
      if (courseId && course.id !== courseId) continue;
      await processCourse(state.snapshot, course.id, { force, openTab: force, onStatus: setStatus });
    }
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
  state.busy.syllabi = true;
  render();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await readUploadedSyllabus(state.snapshot, courseId, { bytes, fileName: file.name, contentType: file.type }, { onStatus: setStatus });
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
  } catch (err) {
    state.linkError = err.message;
  } finally {
    state.busy.link = false;
    state.linkStatus = '';
    render();
  }
  if (state.genai) processSyllabi();
  return Boolean(state.genai);
}

async function setReview(id, value) {
  await store.update(store.KEYS.reviews, (all) => ({ ...(all ?? {}), [id]: value }), {});
}

// ---------- Chats ----------

const activeChat = () => state.chats.find((c) => c.id === state.activeChatId) ?? null;
const chatMessages = () => activeChat()?.messages ?? [];

function saveUi() {
  const { view, courseId, askScope, activeChatId } = state;
  store.set(store.KEYS.ui, { view, courseId, askScope, activeChatId }).catch(() => {});
}

async function saveChats() {
  state.chats = [...state.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_CHATS);
  await store.set(store.KEYS.chats, state.chats);
}

function addMessage(chatId, message) {
  const at = new Date().toISOString();
  state.chats = state.chats.map((c) => (c.id === chatId ? { ...c, updatedAt: at, messages: [...c.messages, message].slice(-MAX_CHAT_MESSAGES) } : c));
  return saveChats();
}

function openChat(id) {
  state.activeChatId = id;
  state.showChats = false;
  state.openTraces.clear();
  saveUi();
  render();
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

async function sendQuestion(question) {
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
  const history = chat.messages.filter((m) => !m.error && !m.stopped).map(({ role, content }) => ({ role, content }));
  state.draft = '';
  state.showChats = false;
  state.pending = { chatId, trace: [], text: '', startedAt: Date.now(), open: true };
  state.abort = new AbortController();
  await addMessage(chatId, { id: crypto.randomUUID(), role: 'user', content: text });
  render();
  const ticker = setInterval(updatePending, 1000);
  let reply;
  try {
    const answer = await ask({
      question: text,
      history,
      snapshot: state.snapshot,
      syllabi: state.syllabi,
      reviews: state.reviews,
      scopeCourseId,
      signal: state.abort.signal,
      onTrace: (trace) => {
        state.pending.trace = trace;
        updatePending();
      },
      onText: (partial) => {
        state.pending.text = partial;
        updatePending();
      },
    });
    reply = { role: 'assistant', content: answer.text, citations: answer.citations, trace: storedTrace(answer.trace) };
  } catch (err) {
    const stopped = err.name === 'AbortError' || state.abort?.signal.aborted;
    reply = { role: 'assistant', content: stopped ? 'Stopped.' : err.message, error: !stopped, stopped, trace: storedTrace(state.pending.trace) };
  } finally {
    clearInterval(ticker);
  }
  reply.id = crypto.randomUUID();
  reply.seconds = Math.round((Date.now() - state.pending.startedAt) / 1000);
  state.pending = null;
  state.abort = null;
  await addMessage(chatId, reply);
  render();
}

function download(fileName, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  h('a', { href: url, download: fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function exportCalendar() {
  const events = calendarEvents(state.snapshot, state.syllabi, state.reviews);
  download('boilerspace.ics', buildCalendar(events, { name: 'BoilerSpace courses' }), 'text/calendar');
}

async function exportData() {
  const all = await store.getAll();
  for (const key of ['genai', 'syncLock', 'syncProgress', 'drawerOpen', 'drawerWidth', 'ui']) delete all[key];
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
  await chrome.storage.local.clear();
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
  const course = withCourse && labelFor(item.courseId);
  return [course && h('span', { class: 'item-course' }, course), course && ' ', parts.filter(Boolean).join(', ')];
}

function agendaItem(item, options) {
  const classes = ['item', item.source === 'syllabus' && 'syllabus', item.kind === 'exam' && 'exam'].filter(Boolean).join(' ');
  return h(
    'li',
    { class: classes },
    h('div', null, link(item.url, item.title, { class: 'item-title' })),
    h('div', { class: 'meta' }, itemMeta(item, options), item.source === 'syllabus' && !item.confirmed ? [' ', h('span', { class: 'tag gold' }, 'from syllabus')] : null),
  );
}

// Firefox and Zen can install the extension without its site access, so ask for it here.
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
    h('p', null, h('strong', null, 'BoilerSpace needs access to Brightspace and GenAI Studio. '), 'Without it, nothing can load.'),
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
      h('div', { class: 'step-title' }, synced ? 'Courses loaded' : 'Load your courses'),
      !synced && h('p', null, 'Reads your current courses from Brightspace while you are signed in. BoilerSpace never changes anything there.'),
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
      h('div', { class: 'step-title' }, connected ? 'GenAI Studio connected' : 'Connect Purdue GenAI Studio'),
      !connected && h('p', null, 'Free with your Purdue login. It reads your syllabi and answers questions about your courses.'),
      state.linkStatus && h('p', { class: 'small', style: 'margin-top:6px' }, state.linkStatus),
      state.linkError && h('p', { class: 'small error-text', style: 'margin-top:6px' }, state.linkError),
      !connected && h('div', { class: 'button-row' }, h('button', { class: synced ? 'button' : 'button secondary', type: 'button', disabled: state.busy.link, onclick: connectGenAI }, state.busy.link ? 'Connecting…' : 'Connect')),
    ),
  );
  return h(
    'section',
    { class: 'setup' },
    h('h2', { class: 'setup-intro' }, 'Your week at Purdue, in one place.'),
    h('p', null, 'Two steps and BoilerSpace keeps itself up to date while you use Brightspace.'),
    h('ol', { class: 'steps' }, brightspaceStep, genaiStep),
  );
}

function connectReminder() {
  if (state.genai) return null;
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Read your syllabi')),
    h('p', { class: 'muted small' }, 'Connect Purdue GenAI Studio, free with your Purdue login, to pull exam dates and policies out of each syllabus and to ask questions.'),
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
  if (d.weekdayMismatch) notes.push('The syllabus names a different weekday for this date. One of them is wrong.');
  const when = d.dueAt ? formatDateTime(d.dueAt, { year: true }) : `${formatDayKey(d.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, no time given`;
  return h(
    'div',
    { class: 'review' },
    h('div', { class: 'row-title' }, d.title),
    h('div', { class: 'meta' }, h('span', { class: 'item-course' }, labelFor(d.courseId)), ` ${d.kind}, ${when}`),
    h('p', { class: 'quote' }, `"${d.quote}" (`, pageRef(d.courseId, d.page), ')'),
    notes.map((n) => h('p', { class: 'note' }, n)),
    h(
      'div',
      { class: 'button-row' },
      h('button', { class: 'button secondary', type: 'button', onclick: () => setReview(d.id, 'confirmed') }, 'Looks right'),
      h('button', { class: 'button secondary', type: 'button', onclick: () => setReview(d.id, 'dismissed') }, 'Ignore'),
    ),
  );
}

function reviewSection(limit = 3) {
  const pending = pendingReviews(state.syllabi, state.reviews);
  if (!pending.length) return null;
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Check these syllabus dates'), h('span', { class: 'meta' }, `${pending.length} to check`)),
    h('p', { class: 'meta', style: 'margin-bottom:6px' }, 'They are in a syllabus but not in Brightspace. Confirmed dates go into your calendar export.'),
    pending.slice(0, limit).map(reviewCard),
    pending.length > limit && h('p', { class: 'meta', style: 'padding-top:6px' }, `${pending.length - limit} more on each course page.`),
  );
}

function agendaSection() {
  const today = dayKey(new Date());
  const end = addDaysToKey(today, AGENDA_DAYS - 1);
  const all = agendaItems(state.snapshot, state.syllabi, state.reviews);
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
      h('div', { class: 'day-date' }, h('span', { class: 'day-num' }, Number(key.slice(8))), h('span', { class: 'day-name' }, name)),
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
  const first = state.snapshot.user?.firstName;
  const date = formatDayKey(dayKey(new Date()), { weekday: 'long', month: 'long', day: 'numeric' });
  return [
    syncErrorNotice(),
    h('p', { class: 'lede' }, first ? [`Hi ${first}. It's `, h('strong', null, date), '.'] : [`It's `, h('strong', null, date), '.']),
    changesSection(),
    agendaSection(),
    reviewSection(),
    announcementsSection(),
    connectReminder(),
  ];
}

// ---------- Courses ----------

function stanceTag(stance, known) {
  if (!known) return h('span', { class: 'tag' }, 'Syllabus not read');
  const cls = { allowed: 'ok', restricted: 'gold', prohibited: 'danger' }[stance] ?? '';
  return h('span', { class: `tag ${cls}` }, STANCE_LABEL[stance] ?? STANCE_LABEL.unclear);
}

function coursesList() {
  const list = courses();
  if (!list.length) return [h('p', { class: 'lede' }, 'No current courses were found.')];
  const items = agendaItems(state.snapshot, state.syllabi, state.reviews);
  const now = new Date().toISOString();
  return [
    h('p', { class: 'lede', style: 'padding-bottom:8px' }, `${plural(list.length, 'current course')} this term.`),
    list.map((course) => {
      const next = items.find((i) => i.courseId === course.id && i.dueAt >= now);
      const record = usableRecord(state.syllabi[course.id]);
      return h(
        'button',
        { class: 'course-row', type: 'button', onclick: () => ((state.courseId = course.id), saveUi(), render({ top: true })) },
        h('span', { class: 'course-label' }, shortCourseLabel(course)),
        stanceTag(record?.policies.aiUse.stance, Boolean(record)),
        h('div', { class: 'meta' }, courseTitle(course)),
        h('div', { class: 'small', style: 'margin-top:2px' }, next ? `Next: ${next.title}, ${formatDateTime(next.dueAt, { allDay: next.allDay })}` : h('span', { class: 'muted' }, 'Nothing upcoming')),
      );
    }),
    excludedNote(),
  ];
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

function policyBlock(record, raw) {
  if (!record) {
    const text = !state.genai
      ? 'Connect GenAI Studio to read the syllabus and find the AI policy.'
      : raw?.status === 'none' || raw?.status === 'external'
        ? 'Unknown until BoilerSpace has a syllabus to read. Pick or upload it below.'
        : 'The syllabus has not been read yet.';
    return h('section', { class: 'policy' }, h('div', { class: 'policy-stance' }, 'AI policy unknown'), h('p', { class: 'small muted' }, text));
  }
  const ai = record.policies.aiUse;
  return h(
    'section',
    { class: `policy ${ai.stance}` },
    h('div', { class: 'policy-stance' }, `${STANCE_SENTENCE[ai.stance]}.`),
    ai.summary && h('p', { class: 'small', style: 'margin-top:2px' }, ai.summary),
    ai.quote && h('p', { class: 'quote' }, `"${ai.quote}" (`, pageRef(record.courseId, ai.page), ')'),
  );
}

function syllabusStatusLine(raw) {
  if (!raw) return state.genai ? (state.busy.syllabi ? 'Reading…' : 'Not read yet.') : 'Connect GenAI Studio to read it.';
  if (raw.status === 'none') return 'No file that looks like a syllabus is in Content or the course overview.';
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
        h('input', { type: 'file', accept: '.pdf,.docx,.pptx,.html,.htm,.txt', disabled: state.busy.syllabi, onchange: (e) => uploadSyllabus(course.id, e.target.files?.[0]) }),
      ),
      raw?.topicId && raw.source !== 'upload' && h('button', { class: 'button secondary', type: 'button', disabled: state.busy.syllabi, onclick: () => processSyllabi({ force: true, courseId: course.id }) }, 'Read again'),
    ),
  );
  return missing ? controls : h('details', { style: 'margin-top:10px' }, h('summary', null, 'Wrong file?'), controls);
}

function courseDetail(course) {
  const raw = state.syllabi[course.id];
  const record = usableRecord(raw);
  const data = state.snapshot.data.find((d) => d.courseId === course.id);
  const now = new Date().toISOString();
  const upcoming = agendaItems(state.snapshot, state.syllabi, state.reviews).filter((i) => i.courseId === course.id && i.dueAt >= now);
  const files = (data?.content ?? []).filter((t) => !t.isHidden);
  const pending = pendingReviews(state.syllabi, state.reviews).filter((d) => d.courseId === course.id);
  const grading = record?.policies.grading ?? [];
  const gradingTotal = grading.reduce((s, g) => s + g.weight, 0);

  return [
    h('div', { class: 'back' }, h('button', { class: 'text-button', type: 'button', onclick: () => ((state.courseId = null), saveUi(), render({ top: true })) }, 'All courses')),
    h('header', { class: 'course-head' }, h('h2', null, shortCourseLabel(course)), h('p', { class: 'muted' }, courseTitle(course), ' ', link(course.homeUrl, 'Open in Brightspace', { class: 'small' }))),
    policyBlock(record, raw),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Syllabus')),
      raw?.title && h('p', null, link(raw.externalUrl ?? raw.url, raw.title)),
      h('p', { class: 'meta' }, syllabusStatusLine(raw)),
      raw?.status === 'error' && record && h('p', { class: 'meta' }, 'Showing what was read last time.'),
      record?.warning && h('p', { class: 'note' }, record.warning),
      record?.dropped?.length > 0 && h('p', { class: 'meta', style: 'margin-top:4px' }, `${plural(record.dropped.length, 'item was', 'items were')} left out because the wording could not be found in the file.`),
      syllabusPicker(course, raw, data),
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
    pending.length > 0 && h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Syllabus dates to check')), pending.map(reviewCard)),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'heading' }, 'Coming up')),
      upcoming.length ? h('ul', { class: 'list' }, upcoming.slice(0, 25).map((item) => agendaItem(item, { withCourse: false, withDay: true }))) : h('p', { class: 'muted' }, 'Nothing upcoming in Brightspace.'),
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
  const pattern = /\*\*([^*]+)\*\*|\[((?:S\d+(?:,\s*)?)+)\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    nodes.push(text.slice(last, match.index));
    if (match[1]) nodes.push(h('strong', null, match[1]));
    else {
      for (const id of match[2].match(/S\d+/g)) {
        const index = citations.findIndex((c) => c.id === id);
        if (index === -1) continue;
        const source = citations[index];
        nodes.push(link(source.url, String(index + 1), { class: 'cite', title: source.label }));
      }
    }
    last = match.index + match[0].length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

function answerBody(text, citations = []) {
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
  return blocks;
}

const duration = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`);

const formatArgs = (args) =>
  Object.entries(args ?? {})
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? `"${value}"` : JSON.stringify(value)}`)
    .join(', ');

function traceStep(entry) {
  if (entry.type === 'thought') {
    return h('li', null, h('div', { class: 'trace-label' }, 'Thinking'), h('div', { class: 'thought-text' }, entry.text));
  }
  return h(
    'li',
    null,
    h('div', { class: 'trace-label' }, entry.active && h('span', { class: 'spinner' }), entry.label),
    entry.name && h('div', { class: 'tool-call' }, h('code', null, `${entry.name}(${formatArgs(entry.args)})`)),
    entry.summary && h('div', { class: `tool-result${entry.summary.startsWith('Failed') ? ' failed' : ''}` }, entry.summary),
  );
}

// The work log above an answer: the model's reasoning and each tool it called, collapsible.
function traceView(trace, { live = false, seconds = 0, open = false, ontoggle, writing = false }) {
  if (!trace.length && !live) return null;
  const tools = trace.filter((e) => e.type === 'tool');
  let summary;
  if (live) {
    const last = trace.at(-1);
    const doing = writing ? 'Writing the answer' : last?.type === 'tool' && last.active ? last.label : 'Thinking';
    summary = [h('span', { class: 'spinner' }), seconds >= 1 ? `${doing}, ${duration(seconds)}` : doing];
  } else {
    const time = seconds ? ` in ${duration(seconds)}` : '';
    summary = [icon('chevron'), tools.length ? `Used ${plural(tools.length, 'tool')}${time}` : `Thought${seconds ? ` for ${duration(seconds)}` : ''}`];
  }
  return h(
    'details',
    { class: `trace${live ? ' live' : ''}`, open, ontoggle },
    h('summary', null, summary),
    trace.length > 0 && h('ol', { class: 'trace-steps' }, trace.map(traceStep)),
  );
}

// Messages saved before the work log existed only have step labels.
const messageTrace = (message) => message.trace ?? (message.steps ?? []).map((label) => ({ type: 'tool', label }));

function messageView(message, index) {
  if (message.role === 'user') return h('div', { class: 'message user' }, message.content);
  const key = message.id ?? `i${index}`;
  const trace = traceView(messageTrace(message), {
    seconds: message.seconds ?? 0,
    open: state.openTraces.has(key),
    ontoggle: (e) => (e.target.open ? state.openTraces.add(key) : state.openTraces.delete(key)),
  });
  if (message.error || message.stopped) return h('div', { class: `message assistant${message.error ? ' error' : ' stopped'}` }, trace, h('p', null, message.content));
  const citations = message.citations ?? [];
  return h(
    'div',
    { class: 'message assistant' },
    trace,
    answerBody(message.content, citations),
    citations.length > 0 && h('div', { class: 'sources' }, citations.map((c, i) => link(c.url, [h('span', { class: 'cite' }, i + 1), h('span', null, c.label)], { title: c.label }))),
  );
}

function pendingView() {
  const p = state.pending;
  return h(
    'div',
    { class: 'message assistant pending', id: 'pending' },
    traceView(p.trace, {
      live: true,
      writing: Boolean(p.text),
      seconds: Math.floor((Date.now() - p.startedAt) / 1000),
      open: p.open,
      ontoggle: (e) => (p.open = e.target.open),
    }),
    p.text && answerBody(p.text),
  );
}

function updatePending() {
  const el = document.getElementById('pending');
  if (!el || !state.pending) return;
  const main = document.getElementById('view');
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 60;
  const next = pendingView();
  el.replaceWith(next);
  for (const box of next.querySelectorAll('.thought-text')) box.scrollTop = box.scrollHeight;
  if (atBottom) main.scrollTop = main.scrollHeight;
}

function policyBanner() {
  if (!state.askScope) return null;
  const ai = aiPolicyFor(state.syllabi, Number(state.askScope));
  if (!ai || !['prohibited', 'restricted'].includes(ai.stance)) return null;
  const label = labelFor(Number(state.askScope));
  const text =
    ai.stance === 'prohibited'
      ? `${label} does not allow AI tools. BoilerSpace will only help with dates, policies and finding things.`
      : `${label} limits AI use${ai.summary ? `: ${ai.summary}` : '.'}`;
  return h('section', { class: `policy ${ai.stance}`, style: 'margin-top:12px' }, h('p', { class: 'small' }, text));
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
          h('span', { class: 'chat-name' }, chat.title),
          h('span', { class: 'meta' }, `${relativeDay(chat.updatedAt)}, ${plural(chat.messages.filter((m) => m.role === 'user').length, 'question')}`),
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
    h('span', { class: 'chat-title' }, state.showChats ? 'Chats' : chat?.title ?? 'New chat'),
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
      e.target.style.height = `${e.target.scrollHeight}px`;
      send.disabled = !state.draft.trim() && !state.pending;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendQuestion(state.draft);
      }
    },
  });
  const send = state.pending
    ? h('button', { class: 'send', type: 'button', 'aria-label': 'Stop', title: 'Stop', onclick: () => state.abort?.abort() }, icon('stop'))
    : h('button', { class: 'send', type: 'submit', 'aria-label': 'Send', title: 'Send', disabled: !state.draft.trim() }, icon('send'));
  queueMicrotask(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });

  const messages = chatMessages();
  const pendingHere = state.pending?.chatId === state.activeChatId ? state.pending : null;
  const empty = messages.length === 0 && !pendingHere;
  return h(
    'div',
    { class: 'ask' },
    askBar(),
    h(
      'label',
      { class: 'scope' },
      'About',
      h(
        'select',
        { onchange: (e) => ((state.askScope = e.target.value), saveUi(), render()) },
        h('option', { value: '' }, 'All my courses'),
        courses().map((c) => h('option', { value: String(c.id), selected: state.askScope === String(c.id) }, shortCourseLabel(c))),
      ),
    ),
    policyBanner(),
    h(
      'div',
      { class: 'messages' },
      empty &&
        h(
          'div',
          { class: 'empty-chat' },
          h('h2', { class: 'heading' }, 'Ask about your courses'),
          h('p', { class: 'muted small', style: 'margin-top:4px' }, 'BoilerSpace looks through your Brightspace data, syllabi, slides and other course files, and links to where it found each answer.'),
          h('ul', { class: 'suggestions' }, SUGGESTED_QUESTIONS.map((q) => h('li', null, h('button', { type: 'button', onclick: () => sendQuestion(q) }, q)))),
        ),
      messages.map(messageView),
      pendingHere && pendingView(),
    ),
    h(
      'div',
      { class: 'composer' },
      h('form', { onsubmit: (e) => (e.preventDefault(), sendQuestion(state.draft)) }, textarea, send),
      h('div', { class: 'footnote' }, `Answers from ${state.genai.model} on Purdue GenAI Studio. Check anything important in Brightspace.`),
    ),
  );
}


// ---------- Settings ----------

function modelField() {
  const models = state.genai.models?.length ? state.genai.models : [state.genai.model];
  if (!state.modelsLoaded) {
    state.modelsLoaded = true;
    refreshModels()
      .then(() => loadState())
      .then(() => state.view === 'settings' && render())
      .catch(() => {});
  }
  return h(
    'label',
    { class: 'field' },
    'Model',
    h(
      'select',
      {
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

function settingsView() {
  const meta = state.syncMeta;
  const errors = meta?.errors ?? [];
  return [
    hostAccessNotice(),
    h(
      'section',
      { class: 'settings-group' },
      h('h2', { class: 'heading' }, 'Purdue GenAI Studio'),
      state.genai
        ? [
            h('p', null, `Connected as ${state.genai.name}.`),
            modelField(),
            h('p', { class: 'meta', style: 'margin-top:12px' }, `Linked ${formatDateTime(state.genai.linkedAt)}. ${state.genai.created ? 'BoilerSpace created your API key.' : 'BoilerSpace is using your existing API key.'}`),
            h('div', { class: 'button-row' }, h('button', { class: 'button secondary', type: 'button', onclick: async () => (await unlink(), await loadState(), render()) }, 'Disconnect')),
            h('p', { class: 'meta', style: 'margin-top:8px' }, 'Disconnecting removes the key from this browser. To revoke the key itself, delete it in GenAI Studio under Settings, Account.'),
          ]
        : [
            h('p', { class: 'muted' }, 'Not connected.'),
            state.linkStatus && h('p', { class: 'small', style: 'margin-top:6px' }, state.linkStatus),
            state.linkError && h('p', { class: 'small error-text', style: 'margin-top:6px' }, state.linkError),
            h('div', { class: 'button-row' }, h('button', { class: 'button', type: 'button', disabled: state.busy.link, onclick: connectGenAI }, state.busy.link ? 'Connecting…' : 'Connect')),
          ],
    ),
    h(
      'section',
      { class: 'settings-group' },
      h('h2', { class: 'heading' }, 'Brightspace'),
      meta
        ? [
            h('p', null, meta.ok ? `Last synced ${formatDateTime(meta.at)}.` : `Last sync failed ${formatDateTime(meta.at)}: ${meta.error}`),
            meta.lastSuccessAt &&
              h('p', { class: 'meta' }, `${plural(courses().length, 'current course')}, ${plural(meta.requestCount ?? 0, 'request')} in ${Math.round((meta.durationMs ?? 0) / 100) / 10} s, signed in by ${meta.authMode === 'token' ? 'token' : 'cookie'}.`),
            errors.length > 0 &&
              h(
                'details',
                { style: 'margin-top:6px' },
                h('summary', null, `${plural(errors.length, 'part')} of your courses could not be loaded`),
                h('ul', { class: 'error-list' }, errors.map((e) => h('li', null, `${e.courseId ? `${labelFor(e.courseId) || e.courseId} ` : ''}${e.section}: ${e.message}`))),
              ),
          ]
        : h('p', { class: 'muted' }, 'Not synced yet.'),
      h('div', { class: 'button-row' }, h('button', { class: 'button secondary', type: 'button', disabled: state.busy.sync, onclick: runSync }, state.busy.sync ? 'Syncing…' : 'Sync now')),
      h('p', { class: 'meta', style: 'margin-top:8px' }, 'BoilerSpace syncs on its own while you use Brightspace, at most every 20 minutes.'),
    ),
    h(
      'section',
      { class: 'settings-group' },
      h('h2', { class: 'heading' }, 'Your data'),
      h('p', { class: 'muted' }, 'Course data stays in this browser. Syllabus text and your questions go to Purdue GenAI Studio. Grades never do.'),
      h(
        'div',
        { class: 'button-row' },
        h('button', { class: 'button secondary', type: 'button', disabled: !state.snapshot, onclick: exportCalendar }, 'Export calendar (.ics)'),
        h('button', { class: 'button secondary', type: 'button', disabled: !state.snapshot, onclick: exportData }, 'Download data (JSON)'),
        h('button', { class: 'button secondary', type: 'button', disabled: !state.snapshot || state.busy.capture, onclick: saveBenchmarkData }, state.busy.capture ? 'Saving benchmark data…' : 'Save benchmark data'),
        h('button', { class: 'button danger', type: 'button', onclick: clearData }, 'Delete all data'),
      ),
      h('p', { class: 'meta', style: 'margin-top:8px' }, 'The calendar file has Brightspace due dates and the syllabus dates you confirmed. Import it into Google Calendar or Outlook.'),
      h('p', { class: 'meta', style: 'margin-top:8px' }, 'Benchmark data is for testing BoilerSpace: your courses and the text of their files, without grades, your name or email addresses. Reading every file takes a few minutes.'),
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

function syncLine() {
  if (state.busy.sync) return 'Syncing';
  const meta = state.syncMeta;
  if (!meta?.lastSuccessAt) return '';
  const minutes = Math.round((Date.now() - Date.parse(meta.lastSuccessAt)) / 60_000);
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : formatDateTime(meta.lastSuccessAt);
  return `Synced ${age}`;
}

const VIEWS = { week: weekView, courses: coursesView, ask: askView, settings: settingsView };

function render({ top = false } = {}) {
  const main = document.getElementById('view');
  const scroll = main.scrollTop;
  const content = CONNECT_PAGE ? connectPageView() : [state.view === 'settings' ? null : hostAccessNotice(), VIEWS[state.view]()];
  main.replaceChildren(h('div', { class: state.view === 'ask' && !CONNECT_PAGE ? 'view ask-view' : 'view' }, content));
  if (state.view === 'ask') main.scrollTop = main.scrollHeight;
  else main.scrollTop = top ? 0 : scroll;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.toggleAttribute('aria-current', false);
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
  }
  renderHeader();
  renderStatus();
}

function renderHeader() {
  document.getElementById('sync-status').textContent = syncLine();
  const syncButton = document.getElementById('sync-button');
  syncButton.disabled = state.busy.sync;
  syncButton.classList.toggle('spinning', state.busy.sync);
  syncButton.hidden = !state.snapshot || CONNECT_PAGE;
}

// Progress updates arrive several times a second during a sync, so they skip the full re-render.
function onSyncActivity() {
  const busy = computeSyncBusy();
  if (busy !== state.busy.sync) {
    state.busy.sync = busy;
    render();
  } else {
    renderHeader();
    renderStatus();
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
  if (CONNECT_PAGE) document.querySelector('.tabs').hidden = true;
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
    const close = document.getElementById('close-button');
    close.hidden = false;
    const closePanel = () => window.parent.postMessage(JSON.stringify({ type: 'boilerspace-close' }), BRIGHTSPACE_ORIGIN);
    close.addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !e.target.closest?.('textarea, select, input') && closePanel());
  }

  await loadState({ includeChat: true });
  render();

  store.onChange(async (changes) => {
    const keys = Object.keys(changes);
    if (changes.chats && !state.pending) {
      const chats = changes.chats.newValue ?? [];
      if (JSON.stringify(chats) !== JSON.stringify(state.chats)) {
        state.chats = chats;
        if (!chats.some((c) => c.id === state.activeChatId)) state.activeChatId = null;
        if (state.view === 'ask') render();
      }
    }
    if (keys.every((k) => ['chat', 'chats', 'ui', 'drawerOpen', 'drawerWidth'].includes(k))) return;
    if (keys.every((k) => ['syncLock', 'syncProgress'].includes(k))) {
      if (changes.syncLock) state.syncLock = changes.syncLock.newValue ?? null;
      if (changes.syncProgress) state.progress = changes.syncProgress.newValue ?? null;
      onSyncActivity();
      return;
    }
    const snapshotChanged = keys.includes('snapshot');
    const linked = keys.includes('genai') && !changes.genai.oldValue && changes.genai.newValue;
    await loadState();
    if (!state.pending) render();
    if (CONNECT_PAGE && linked) setTimeout(() => window.close(), 1500);
    if (snapshotChanged || linked) processSyllabi();
  });
  setInterval(onSyncActivity, 3000);

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
  if (syncAge > SYNC_ON_OPEN_AFTER_MS && (await attempt(canReachBrightspace))) runSync();
  else processSyllabi();
}

init();
