// Brightspace (D2L Valence) client for Purdue. Runs inside a purdue.brightspace.com tab so
// every request carries the student's own session. Read-only: it only sends GETs, plus the
// token request that Brightspace's own web components use.

import { shortCourseLabel } from './courses.js';

export const DEFAULT_VERSIONS = { lp: '1.62', le: '1.96' };

const REQUEST_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 100_000_000;
const DECK_FILE_BYTES = 200_000_000;
const MAX_CONCURRENT_REQUESTS = 3;
const DAY_MS = 86_400_000;
const COURSE_GRACE_DAYS = 14;
const RECENTLY_OPENED_DAYS = 120;
const CALENDAR_PAST_DAYS = 7;
const CALENDAR_FUTURE_DAYS = 150;
const SYLLABUS_PATTERN = /syllab|course\s+(info|information|outline|polic(y|ies)|overview|schedule)/i;

export class BrightspaceError extends Error {
  constructor(message, { status = null, path = null } = {}) {
    super(message);
    this.name = 'BrightspaceError';
    this.status = status;
    this.path = path;
  }
}

// ---------- Low-level client ----------

export function createClient({ origin, fetchImpl = fetch, xsrfToken = null } = {}) {
  let bearer = null;
  const requestLog = [];

  async function mintBearer() {
    if (!xsrfToken) throw new BrightspaceError("Brightspace's XSRF token was not found on this page.");
    const res = await fetchImpl(`${origin}/d2l/lp/auth/oauth2/token`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Csrf-Token': xsrfToken },
      body: 'scope=*:*:*',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    requestLog.push({ path: '/d2l/lp/auth/oauth2/token', status: res.status, ms: null, auth: 'token request' });
    if (!res.ok) throw new BrightspaceError(`Token request failed (HTTP ${res.status}).`, { status: res.status });
    bearer = JSON.parse(await res.text()).access_token;
    if (!bearer) throw new BrightspaceError('Token response had no access_token.');
  }

  async function request(path, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const res = await fetchImpl(origin + path, {
        credentials: 'include',
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      const usedBearer = Boolean(bearer);
      requestLog.push({ path, status: res.status, ms: Date.now() - started, auth: usedBearer ? 'token' : 'cookie' });

      // A cookie-only call can be refused where a token call works, and tokens expire after about an hour.
      const shouldRetry = attempt === 0 && (res.status === 401 || (res.status === 403 && !usedBearer));
      if (shouldRetry && xsrfToken) {
        await mintBearer();
        continue;
      }
      if (!res.ok) throw new BrightspaceError(`HTTP ${res.status}`, { status: res.status, path });
      return res;
    }
  }

  async function getJson(path) {
    const res = await request(path);
    if (!(res.headers.get('content-type') ?? '').includes('json')) {
      // A dead session gets an HTML sign-in page with HTTP 200 instead of JSON.
      throw new BrightspaceError('Brightspace returned a web page instead of data. The session may have expired.', { path });
    }
    return JSON.parse(await res.text());
  }

  // Cookie only. A bearer header makes Brightspace answer this HTML page with something other than the navbar.
  async function getText(path, { maxBytes = 1_500_000 } = {}) {
    const started = Date.now();
    const res = await fetchImpl(origin + path, {
      credentials: 'include',
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    requestLog.push({ path, status: res.status, ms: Date.now() - started, auth: 'cookie' });
    if (!res.ok) throw new BrightspaceError(`HTTP ${res.status}`, { status: res.status, path });
    const source = new Uint8Array(await res.arrayBuffer());
    const length = Math.min(source.length, maxBytes);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = source[i];
    return new TextDecoder().decode(bytes);
  }

  async function getFile(path) {
    const res = await request(path, { timeoutMs: FILE_TIMEOUT_MS });
    const contentType = res.headers.get('content-type') ?? '';
    const source = new Uint8Array(await res.arrayBuffer());
    const limit = fileByteLimit(source);
    if (source.length > limit) {
      const sizeMb = Math.max(1, Math.round(source.length / 1_000_000));
      throw new BrightspaceError(`File is ${sizeMb} MB, over the ${limit / 1_000_000} MB limit.`, { path });
    }
    const bytes = await ownBytes(source);
    return { bytes, contentType, fileName: fileNameFromDisposition(res.headers.get('content-disposition')) };
  }

  // Valence has three list shapes: bare arrays, { Objects, Next }, and { Items, PagingInfo }.
  async function getAll(path) {
    const results = [];
    let next = path;
    while (next) {
      const page = await getJson(next);
      if (Array.isArray(page)) return page;
      if (Array.isArray(page.Objects)) {
        results.push(...page.Objects);
        next = page.Next ? toPath(page.Next, origin) : null;
      } else if (Array.isArray(page.Items)) {
        results.push(...page.Items);
        const bookmark = page.PagingInfo?.HasMoreItems ? page.PagingInfo.Bookmark : null;
        next = bookmark ? withQuery(path, { bookmark }) : null;
      } else {
        return [page];
      }
    }
    return results;
  }

  return { getJson, getAll, getText, getFile, requestLog, get authMode() { return bearer ? 'token' : 'cookie'; } };
}

export function fileNameFromDisposition(header) {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain filename */
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim() ?? null;
}

function toPath(url, origin) {
  const parsed = new URL(url, origin);
  return parsed.pathname + parsed.search;
}

function withQuery(path, params) {
  const url = new URL(path, 'https://placeholder.invalid');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.pathname + url.search;
}

// ---------- Normalizers (pure, tested against Brightspace Bar's recorded responses) ----------

export function richText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.Text === 'string' && value.Text.trim()) return value.Text.trim();
  if (value.Text && typeof value.Text === 'object') return richText(value.Text);
  if (typeof value.Html === 'string') return htmlToText(value.Html);
  return '';
}

function htmlToText(html) {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeEnrollment(item) {
  const unit = item?.OrgUnit ?? {};
  const access = item?.Access ?? {};
  return {
    id: unit.Id,
    name: unit.Name ?? '(untitled course)',
    code: unit.Code ?? '',
    typeId: unit.Type?.Id ?? null,
    homeUrl: unit.HomeUrl ?? null,
    isActive: access.IsActive !== false,
    canAccess: access.CanAccess !== false,
    role: access.ClasslistRoleName ?? null,
    startDate: isoOrNull(access.StartDate),
    endDate: isoOrNull(access.EndDate),
    lastAccessed: isoOrNull(access.LastAccessed),
  };
}

export function withCourseDetails(course, details) {
  if (!details) return course;
  return {
    ...course,
    startDate: course.startDate ?? isoOrNull(details.StartDate),
    endDate: course.endDate ?? isoOrNull(details.EndDate),
    semester: details.Semester?.Name ?? null,
    isActive: course.isActive && details.IsActive !== false,
  };
}

// Returns { current, reason } so the UI can show why each course was kept or dropped.
export function classifyCourse(course, now = new Date()) {
  if (course.typeId !== null && course.typeId !== 3) return { current: false, reason: 'not a course offering' };
  if (!course.canAccess) return { current: false, reason: 'no access' };
  if (!course.isActive) return { current: false, reason: 'inactive' };

  const time = now.getTime();
  const start = course.startDate ? Date.parse(course.startDate) : null;
  const end = course.endDate ? Date.parse(course.endDate) : null;
  if (start !== null || end !== null) {
    if (end !== null && end < time - COURSE_GRACE_DAYS * DAY_MS) return { current: false, reason: 'ended' };
    if (start !== null && start > time + COURSE_GRACE_DAYS * DAY_MS) return { current: false, reason: 'not started' };
    return { current: true, reason: 'course dates include today' };
  }
  if (course.lastAccessed && Date.parse(course.lastAccessed) > time - RECENTLY_OPENED_DAYS * DAY_MS) {
    return { current: true, reason: `no dates; opened in the last ${RECENTLY_OPENED_DAYS} days` };
  }
  return { current: false, reason: 'no dates and not opened recently' };
}

export function normalizeAssignment(folder, courseId, origin) {
  return {
    kind: 'assignment',
    id: folder.Id,
    courseId,
    title: folder.Name ?? '(untitled assignment)',
    dueAt: isoOrNull(folder.DueDate),
    startAt: isoOrNull(folder.Availability?.StartDate),
    endAt: isoOrNull(folder.Availability?.EndDate),
    instructions: richText(folder.CustomInstructions),
    points: folder.Assessment?.ScoreDenominator ?? null,
    hasRubric: (folder.Assessment?.Rubrics?.length ?? 0) > 0,
    isHidden: Boolean(folder.IsHidden),
    url: `${origin}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folder.Id}&ou=${courseId}`,
  };
}

const QUIZ_QUESTION_CHARS = 900;
const QUIZ_QUESTION_LIMIT = 500;

// A quiz with no end stays open. Once the later of the due date and the end date has passed, it is closed.
export function quizStillOpen(quiz, now = new Date()) {
  const times = [quiz?.endAt, quiz?.dueAt].map((value) => Date.parse(value)).filter((n) => !Number.isNaN(n));
  if (!times.length) return true;
  return Math.max(...times) > now.getTime();
}

function choiceText(answer) {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer.trim();
  return richText(answer.Answer ?? answer.AnswerText ?? answer.Text ?? '');
}

// Question text and the choices that were shown. Weights, correct flags and scores stay out.
export function visibleQuizQuestions(payload) {
  const list = Array.isArray(payload) ? payload : payload?.Objects ?? payload?.Items ?? [];
  const questions = [];
  for (const item of list) {
    const question = item?.Question ?? item;
    if (!question || typeof question !== 'object') continue;
    const info = question.QuestionInfo ?? {};
    let text = richText(info.QuestionText ?? question.QuestionText ?? question.Name);
    if (Array.isArray(info.Segments) && info.Segments.length) {
      text = info.Segments.map((segment) => (segment.Blank ? '____' : richText(segment.Text))).join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim().slice(0, QUIZ_QUESTION_CHARS);
    if (!text) continue;
    let choices = [];
    if (Array.isArray(info.Answers)) choices = info.Answers.map(choiceText).filter(Boolean).slice(0, 12);
    else if (Object.prototype.hasOwnProperty.call(info, 'IsTrue')) choices = ['True', 'False'];
    questions.push({ number: questions.length + 1, text, ...(choices.length ? { choices } : {}) });
    if (questions.length >= QUIZ_QUESTION_LIMIT) break;
  }
  return questions;
}

export function questionsFromReviewHtml(html) {
  const clean = String(html ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const modern = clean.split(/<div\b[^>]*class=["'][^"']*\bupdated-submission-question-header\b[^"']*["'][^>]*>/i);
  if (modern.length > 1) {
    const blockText = part => {
      const encoded = /<d2l-html-block\b[^>]*\bhtml="([^"]*)"/i.exec(part)?.[1];
      if (!encoded) return '';
      const decoded = encoded.replace(/&(?:quot|apos|lt|gt|amp);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
        const named = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
        if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
        const number = entity.slice(2, -1);
        const point = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
        return point <= 0x10ffff ? String.fromCodePoint(point) : '';
      });
      return htmlToText(decoded).replace(/\s+/g, ' ').trim().slice(0, QUIZ_QUESTION_CHARS);
    };
    return modern.slice(1, QUIZ_QUESTION_LIMIT + 1).flatMap(part => {
      const text = blockText(part);
      if (!text) return [];
      const choices = part.split(/<div\b[^>]*class=["'][^"']*\bd2l-quiz-answer-container\b[^"']*["'][^>]*>/i).slice(1).map(blockText).filter(Boolean).slice(0, 12);
      return [{ text, ...(choices.length ? { choices } : {}) }];
    }).map((question, index) => ({ number: index + 1, ...question }));
  }
  const parts = clean.split(/<(?:div|td)\b[^>]*class="[^"]*(?:d2l-quiz-question-text|dco_qtext)[^"]*"[^>]*>/i);
  if (parts.length < 2) return [];
  const questions = [];
  for (const part of parts.slice(1)) {
    const text = htmlToText(part.split(/<\/(?:div|td)>/i)[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, QUIZ_QUESTION_CHARS);
    if (!text) continue;
    questions.push({ number: questions.length + 1, text });
    if (questions.length >= QUIZ_QUESTION_LIMIT) break;
  }
  return questions;
}

export function completedQuizReviewPaths(html, courseId, quizId) {
  const paths = new Set();
  for (const match of String(html ?? '').matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, '&'), 'https://purdue.brightspace.com');
      if (url.origin !== 'https://purdue.brightspace.com' || !/^\/d2l\/lms\/quizzing\/user\/(?:quiz_submissions_attempt|attempt\/quiz_review)\.d2l$/.test(url.pathname)) continue;
      if (url.searchParams.get('ou') !== String(courseId) || url.searchParams.get('qi') !== String(quizId) || !/^\d+$/.test(url.searchParams.get('ai') ?? '')) continue;
      paths.add(url.pathname + url.search);
    } catch { /* Ignore a malformed review link. */ }
  }
  return [...paths].reverse().slice(0, 3);
}

async function quietGet(client, path, { text = false } = {}) {
  try {
    return text ? await client.getText(path) : await client.getJson(path);
  } catch (err) {
    if (err.status === 403 || err.status === 404) return null;
    throw err;
  }
}

// Questions the student already saw on a finished attempt, or the quiz itself after it has closed.
// An open quiz with no finished attempt stays unread. Scores are never returned.
export async function readQuiz(client, { courseId, quizId, le, dueAt = null, endAt = null, now = new Date() }) {
  const base = `/d2l/api/le/${le}/${courseId}/quizzes/${quizId}`;
  const attempts = (await quietGet(client, `${base}/attempts/`)) ?? [];
  const finished = (Array.isArray(attempts) ? attempts : attempts.Objects ?? []).filter((attempt) => attempt?.Completed);
  const latest = finished.at(-1);
  if (latest?.AttemptId) {
    const fromAttempt = visibleQuizQuestions(await quietGet(client, `${base}/attempts/${latest.AttemptId}/questions/`));
    if (fromAttempt.length) return { questions: fromAttempt };
    const reviewPath = `/d2l/lms/quizzing/user/attempt/quiz_review.d2l?qi=${quizId}&ou=${courseId}&ai=${latest.AttemptId}`;
    const fromReview = questionsFromReviewHtml(await quietGet(client, reviewPath, { text: true }));
    if (fromReview.length) return { questions: fromReview };
  }
  // Student roles can be denied the attempts API while their completed reviews remain visible.
  const submissionsHtml = await quietGet(client, `/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=${quizId}&ou=${courseId}`, { text: true });
  const submissions = questionsFromReviewHtml(submissionsHtml);
  if (submissions.length) return { questions: submissions };
  for (const path of completedQuizReviewPaths(submissionsHtml, courseId, quizId)) {
    const questions = questionsFromReviewHtml(await quietGet(client, path, { text: true }));
    if (questions.length) return { questions };
  }
  if (quizStillOpen({ dueAt, endAt }, now)) {
    return { questions: [], note: 'This quiz can still be taken, so its questions stay hidden.' };
  }
  const fromBank = visibleQuizQuestions(await quietGet(client, `${base}/questions/`));
  if (fromBank.length) return { questions: fromBank };
  return { questions: [], note: 'Brightspace did not release the questions for this quiz.' };
}

export function normalizeQuiz(quiz, courseId, origin) {
  return {
    kind: 'quiz',
    id: quiz.QuizId,
    courseId,
    title: quiz.Name ?? '(untitled quiz)',
    dueAt: isoOrNull(quiz.DueDate),
    startAt: isoOrNull(quiz.StartDate),
    endAt: isoOrNull(quiz.EndDate),
    instructions: richText(quiz.Description),
    timeLimitMinutes: quiz.SubmissionTimeLimit?.IsEnforced ? quiz.SubmissionTimeLimit.TimeLimitValue : null,
    attempts: quiz.AttemptsAllowed?.IsUnlimited ? 'unlimited' : quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null,
    isActive: quiz.IsActive !== false,
    url: `${origin}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${quiz.QuizId}&ou=${courseId}`,
  };
}

export function normalizeAnnouncement(item, courseId, origin) {
  return {
    kind: 'announcement',
    id: item.Id,
    courseId,
    title: item.Title ?? '(untitled announcement)',
    body: richText(item.Body),
    postedAt: isoOrNull(item.StartDate) ?? isoOrNull(item.CreatedDate),
    updatedAt: isoOrNull(item.LastModifiedDate),
    isHidden: Boolean(item.IsHidden),
    url: `${origin}/d2l/le/news/${courseId}/${item.Id}/view`,
  };
}

export function normalizeCalendarEvent(event, courseId, origin) {
  const ou = event.OrgUnitId ?? courseId;
  return {
    kind: 'event',
    id: event.CalendarEventId,
    courseId: ou,
    url: origin ? `${origin}/d2l/le/calendar/${ou}/event/${event.CalendarEventId}/detailsview` : null,
    title: event.Title ?? '(untitled event)',
    startAt: isoOrNull(event.StartDateTime),
    endAt: isoOrNull(event.EndDateTime),
    isAllDay: Boolean(event.IsAllDayEvent),
    description: richText(event.Description),
    location: event.LocationName ?? null,
    linkedTo: event.AssociatedEntity?.AssociatedEntityType ?? null,
  };
}

export function normalizeGrade(value) {
  return {
    name: value.GradeObjectName ?? '(unnamed grade item)',
    displayed: value.DisplayedGrade ?? null,
    points: value.PointsDenominator ? { earned: value.PointsNumerator, possible: value.PointsDenominator } : null,
    lastModified: isoOrNull(value.LastModified),
  };
}

// Files uploaded to a course live under /content/enforced/, and link topics often point straight at them.
const COURSE_FILE_PATH = /^\/content\/enforced\/(?!.*\.\.)[^?#]+$/;

function topicFileUrl(topic, courseId, origin) {
  if (topic.TypeIdentifier === 'File') return `/d2l/api/le/{le}/${courseId}/content/topics/${topic.TopicId}/file`;
  if (topic.TypeIdentifier !== 'Link' || !topic.Url) return null;
  try {
    const url = new URL(topic.Url, origin);
    return url.origin === origin && COURSE_FILE_PATH.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

// The file's own address, which the browser's PDF viewer can open at a page (#page=N).
function fileHref(topic, origin) {
  if (!topic.Url || !['File', 'Link'].includes(topic.TypeIdentifier)) return null;
  try {
    const url = new URL(topic.Url, origin);
    return url.origin === origin && COURSE_FILE_PATH.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

function externalUrl(topic, origin) {
  if (topic.TypeIdentifier !== 'Link' || !topic.Url) return null;
  try {
    const url = new URL(topic.Url, origin);
    return url.origin === origin ? null : url.href;
  } catch {
    return null;
  }
}

// Flattens nested modules into topics with their module path, flagging likely syllabi.
export function flattenToc(toc, courseId, origin) {
  const topics = [];
  const walk = (modules, path) => {
    for (const module of modules ?? []) {
      const modulePath = [...path, module.Title ?? '(untitled module)'];
      for (const topic of module.Topics ?? []) {
        const title = topic.Title ?? '(untitled topic)';
        topics.push({
          kind: 'content',
          id: topic.TopicId,
          courseId,
          title,
          modulePath,
          type: topic.TypeIdentifier ?? null,
          url: `${origin}/d2l/le/content/${courseId}/viewContent/${topic.TopicId}/View`,
          fileUrl: topicFileUrl(topic, courseId, origin),
          fileHref: fileHref(topic, origin),
          externalUrl: externalUrl(topic, origin),
          isHidden: Boolean(topic.IsHidden),
          updatedAt: isoOrNull(topic.LastModifiedDate),
          looksLikeSyllabus: SYLLABUS_PATTERN.test(title) || modulePath.some((m) => SYLLABUS_PATTERN.test(m)),
        });
      }
      walk(module.Modules, modulePath);
    }
  };
  walk(toc?.Modules, []);
  return topics;
}

// ---------- Sync ----------

export async function discoverVersions(client) {
  try {
    const products = await client.getJson('/d2l/api/versions/');
    const latest = (code) => products.find((p) => p.ProductCode === code)?.LatestVersion;
    return { lp: latest('lp') ?? DEFAULT_VERSIONS.lp, le: latest('le') ?? DEFAULT_VERSIONS.le };
  } catch {
    return { ...DEFAULT_VERSIONS };
  }
}

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function section(errors, courseId, name, load, { empty = [], missingOk = false } = {}) {
  try {
    return await load();
  } catch (err) {
    if (!(missingOk && err.status === 404)) errors.push({ courseId, section: name, status: err.status ?? null, message: err.message });
    return empty;
  }
}

const TOPIC_TYPE = { 1: 'File', 3: 'Link' };
const ACTIVITY_TYPE = { 1: 'File', 2: 'Link' };

function decodeHref(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function linkLabel(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function framedName(href) {
  const framed = /[?&]framedName=([^&#"']*)/i.exec(href)?.[1] ?? '';
  if (!framed) return '';
  try {
    return decodeURIComponent(framed.replace(/\+/g, ' '));
  } catch {
    return framed;
  }
}

const isSyllabusName = (value) => /^syllabus$/i.test((value ?? '').replace(/\s+/g, ' ').trim());

// Navbar links named Syllabus. The tab is often a quicklink (framedName=Syllabus) on a custom element, not an <a>.
export function syllabusNavLinks(html) {
  const source = String(html ?? '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003f/gi, '?')
    .replace(/\\\//g, '/');
  const found = [];
  const seen = new Set();
  const add = (href, text) => {
    href = decodeHref(href ?? '');
    if (!href || seen.has(href)) return;
    const name = framedName(href);
    if (!isSyllabusName(text) && !isSyllabusName(name)) return;
    seen.add(href);
    found.push({ href, text: (text || name || 'Syllabus').replace(/\s+/g, ' ').trim() || 'Syllabus' });
  };

  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchors.exec(source))) {
    const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(match[1]);
    add(hrefMatch?.[2] ?? hrefMatch?.[3] ?? '', linkLabel(match[2]));
  }
  const tags = /<([a-z0-9-]+)\b([^>]*)>/gi;
  while ((match = tags.exec(source))) {
    const attrs = match[2];
    const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!hrefMatch) continue;
    const textAttr = /\b(?:text|title|aria-label)\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    add(hrefMatch[2] ?? hrefMatch[3] ?? '', textAttr?.[2] ?? textAttr?.[3] ?? '');
  }
  const raw = /(?:https?:\/\/|\/)[^"'\\\s<>]*framedName(?:=|%3D)Syllabus/gi;
  while ((match = raw.exec(source))) add(match[0].replace(/%3D/i, '='), 'Syllabus');
  return found;
}

// The open Brightspace page already shows this course's navbar, including links inside shadow roots.
export function syllabusHrefsInDocument(doc) {
  if (!doc?.querySelectorAll && !doc?.location?.href) return [];
  const found = [];
  const seen = new Set();
  const add = (href, text = '') => {
    href = decodeHref(String(href ?? ''));
    if (!href || seen.has(href)) return;
    if (!isSyllabusName(text) && !isSyllabusName(framedName(href))) return;
    seen.add(href);
    found.push(href);
  };
  if (doc.location?.href) add(doc.location.href);
  const visit = (root) => {
    if (!root?.querySelectorAll) return;
    for (const el of root.querySelectorAll('*')) {
      const href = el.getAttribute?.('href') || (typeof el.href === 'string' ? el.href : '');
      const text = el.getAttribute?.('text') || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.textContent || '';
      add(href, text);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(doc);
  return found;
}

export function syllabusHrefInDocument(doc, courseId) {
  if (courseId == null) return null;
  const page = `${doc?.location?.pathname ?? ''}${doc?.location?.search ?? ''}`;
  for (const href of syllabusHrefsInDocument(doc)) {
    const target = contentTargetFromHref(href);
    if (!target) continue;
    if (!target.orgUnitId || target.orgUnitId === Number(courseId) || page.includes(String(courseId))) return href;
  }
  return null;
}

// A content quicklink's code ends with the topic id. srcou is the org unit that owns the file.
export function contentTargetFromHref(href) {
  let url;
  try {
    url = new URL(href, 'https://purdue.brightspace.com');
  } catch {
    return null;
  }
  if (/quickLink\.d2l$/i.test(url.pathname)) {
    const type = (url.searchParams.get('type') ?? '').toLowerCase();
    if (type === 'lti') return { topicId: null, orgUnitId: Number(url.searchParams.get('ou')) || null, sourceOrgUnitId: null, launchHref: url.pathname + url.search };
    if (type && type !== 'content') return null;
    const code = url.searchParams.get('code') ?? url.searchParams.get('rcode') ?? '';
    const topicId = /-(\d+)$/.exec(code)?.[1] ?? (/^\d+$/.test(code) ? code : null);
    if (!topicId) return null;
    return {
      topicId: Number(topicId),
      orgUnitId: Number(url.searchParams.get('ou')) || null,
      sourceOrgUnitId: Number(url.searchParams.get('srcou')) || null,
    };
  }
  const view = /\/content\/(\d+)\/viewContent\/(\d+)\/View$/i.exec(url.pathname);
  if (view) return { topicId: Number(view[2]), orgUnitId: Number(view[1]), sourceOrgUnitId: null };
  if (COURSE_FILE_PATH.test(url.pathname)) return { topicId: null, orgUnitId: null, sourceOrgUnitId: null, filePath: url.pathname };
  return null;
}

function topicAsToc(topic, topicId) {
  const type = topic.TypeIdentifier ?? TOPIC_TYPE[topic.TopicType] ?? ACTIVITY_TYPE[topic.ActivityType] ?? 'File';
  return {
    TypeIdentifier: type,
    TopicId: topic.TopicId ?? topic.Id ?? topicId,
    Url: topic.Url ?? null,
    Title: topic.Title ?? 'Syllabus',
    LastModifiedDate: topic.LastModifiedDate ?? null,
  };
}

// The Syllabus tab is a navbar link. It is often an HTML page, and it is often missing from Content.
function syllabusLinkForCourse(hrefs, courseId, { scopedPage = false } = {}) {
  for (const href of hrefs) {
    if (!href) continue;
    const target = contentTargetFromHref(href);
    if (!target?.topicId && !target?.filePath && !target?.launchHref) continue;
    if (target.orgUnitId && target.orgUnitId !== Number(courseId)) continue;
    if (!target.orgUnitId && !scopedPage) {
      const owner = /^\/content\/enforced\/(\d+)(?:-|\/)/.exec(target.filePath ?? '')?.[1];
      if (Number(owner) !== Number(courseId)) continue;
    }
    if (new URL(href, 'https://purdue.brightspace.com').origin !== 'https://purdue.brightspace.com') continue;
    return { href, text: 'Syllabus' };
  }
  return null;
}

const SYLLABUS_TEXT_MIN = 600;
const SYLLABUS_TEXT_MAX = 120_000;

function plainText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function withSyllabusText(tab, text) {
  if (!tab || !text || text.length < SYLLABUS_TEXT_MIN) return tab;
  return { ...tab, text: text.slice(0, SYLLABUS_TEXT_MAX), textLabel: 'page 1' };
}

// The HTML file behind the tab, when Brightspace serves it directly.
async function syllabusFileText(client, fileHref) {
  if (!fileHref || !/\.html?($|\?)/i.test(fileHref)) return null;
  try {
    const html = await client.getText(fileHref);
    if (/aria-busy\s*=\s*["']true|>\s*(?:Loading(?:\s+[^<]{0,40})?|Please wait)[.…\s]*</i.test(html)) return null;
    return plainText(html);
  } catch {
    return null;
  }
}

function templateSyllabusTopic(topics) {
  const rank = (topic) => {
    if (topic.isHidden || (!topic.fileUrl && !topic.externalUrl)) return 0;
    const title = topic.title ?? '';
    const file = `${topic.fileHref ?? ''} ${topic.fileUrl ?? ''}`;
    if (/^syllabus$/i.test(title.trim())) return 30;
    if (/syllab/i.test(title) && /\.(html?|pdf|docx?)$/i.test(`${title} ${file}`)) return 20;
    if (/syllab/i.test(file)) return 16;
    if (/syllab/i.test(title)) return 12;
    return 0;
  };
  return topics
    .map((topic) => ({ topic, score: rank(topic) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.topic ?? null;
}

// The Syllabus tab is often a file on the course template, shared into the offering but absent from its Content list.
async function syllabusFromTemplate(client, { courseId, le, lp, origin }) {
  if (!lp) return null;
  let templateId = null;
  try {
    const details = await client.getJson(`/d2l/api/lp/${lp}/courses/${courseId}`);
    const id = Number(details?.CourseTemplate?.Identifier);
    if (id && id !== Number(courseId)) templateId = id;
  } catch (err) {
    if (err.status !== 404 && err.status !== 403) throw err;
  }
  if (!templateId) {
    try {
      const parents = await client.getJson(`/d2l/api/lp/${lp}/orgstructure/${courseId}/parents`);
      const list = Array.isArray(parents) ? parents : parents?.Items ?? [];
      const template = list.find((unit) => /template/i.test(`${unit?.Type?.Code ?? ''} ${unit?.Type?.Name ?? ''}`));
      const id = Number(template?.Identifier ?? template?.Id);
      if (id && id !== Number(courseId)) templateId = id;
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
    }
  }
  if (!templateId) return null;
  try {
    const topics = flattenToc(await client.getJson(`/d2l/api/le/${le}/${templateId}/content/toc`), templateId, origin).map((topic) => ({
      ...topic,
      fileUrl: topic.fileUrl?.replace('{le}', le) ?? null,
    }));
    const hit = templateSyllabusTopic(topics);
    if (!hit) return null;
    return {
      id: `tab:${hit.id}`,
      title: 'Syllabus',
      modulePath: [],
      fileUrl: hit.fileUrl,
      fileHref: hit.fileHref,
      url: hit.url,
      updatedAt: hit.updatedAt,
    };
  } catch (err) {
    if (err.status !== 404 && err.status !== 403) throw err;
    return null;
  }
}

async function readSyllabusTabText(client, tab, readTab, href) {
  const fromFile = await syllabusFileText(client, tab.fileHref);
  if (fromFile?.length >= SYLLABUS_TEXT_MIN) return withSyllabusText(tab, fromFile);
  // Let the normal file reader handle PDFs and Office files, without loading a viewer tab.
  if (tab.fileHref && /\.(pdf|doc[xm]|dot[xm]|ppt[xm]|pps[xm]|pot[xm]|rtf|txt|md)($|\?)/i.test(tab.fileHref)) return tab;
  if (!readTab?.page) return tab;
  const text = await readTab.page(href);
  if (text?.notFound) return null;
  if (!text || text.length < SYLLABUS_TEXT_MIN) throw new Error('The syllabus page did not finish loading. Try reading it again.');
  return withSyllabusText(tab, text);
}

export async function findSyllabusTab(client, { courseId, le, lp = null, origin, pageLinks = [], readTab = null }) {
  const live = typeof globalThis.document === 'undefined' ? [] : syllabusHrefsInDocument(globalThis.document);
  const page = globalThis.document?.location?.href ?? '';
  const scopedPage = new RegExp(`/(?:home|content)/${courseId}(?:[/?#]|$)`).test(page) || new URL(page || origin).searchParams.get('ou') === String(courseId);
  let link = syllabusLinkForCourse([...pageLinks, ...live], courseId, { scopedPage });
  if (!link) {
    const fromTemplate = await syllabusFromTemplate(client, { courseId, le, lp, origin });
    if (fromTemplate) {
      return readSyllabusTabText(client, fromTemplate, readTab, fromTemplate.fileHref || fromTemplate.url);
    }
  }
  if (!link) {
    let html;
    for (const path of [`/d2l/home/${courseId}`, `/d2l/le/content/${courseId}/Home`]) {
      try {
        html = await client.getText(path);
      } catch (err) {
        if (err.status === 404) continue;
        throw err;
      }
      link = syllabusLinkForCourse(syllabusNavLinks(html).map((item) => item.href), courseId, { scopedPage: true });
      if (link) break;
    }
  }
  if (!link && readTab?.links) {
    link = syllabusLinkForCourse((await readTab.links(courseId)) ?? [], courseId, { scopedPage: true });
  }
  if (!link) return null;
  const target = contentTargetFromHref(link.href);
  if (!target) return null;
  if (target.launchHref) {
    if (!readTab?.page) throw new Error('The Simple Syllabus reader is unavailable. Reload BoilerSpace and Brightspace.');
    const text = await readTab.page(target.launchHref);
    if (text?.notFound) return null;
    if (!text || text.length < SYLLABUS_TEXT_MIN) throw new Error('Simple Syllabus did not finish loading.');
    return withSyllabusText({ id: `tab:${courseId}:lti`, title: 'Syllabus', modulePath: [], fileUrl: null, fileHref: null, url: new URL(target.launchHref, origin).href, updatedAt: null }, text);
  }
  let tab;
  if (target.filePath) {
    tab = { id: `tab:${courseId}:file`, title: 'Syllabus', modulePath: [], fileUrl: target.filePath, fileHref: target.filePath, url: new URL(link.href, origin).href, updatedAt: null };
  } else {
    const orgUnits = [...new Set([target.sourceOrgUnitId, courseId, target.orgUnitId].filter(Boolean))];
    for (const ou of orgUnits) {
      try {
        const topic = topicAsToc(await client.getJson(`/d2l/api/le/${le}/${ou}/content/topics/${target.topicId}`), target.topicId);
        const fileUrl = topicFileUrl(topic, ou, origin)?.replace('{le}', le) ?? `/d2l/api/le/${le}/${ou}/content/topics/${topic.TopicId}/file`;
        tab = {
          id: `tab:${topic.TopicId}`,
          title: 'Syllabus',
          modulePath: [],
          fileUrl,
          fileHref: fileHref(topic, origin),
          url: `${origin}/d2l/le/content/${ou}/viewContent/${topic.TopicId}/View`,
          updatedAt: isoOrNull(topic.LastModifiedDate),
        };
        break;
      } catch (err) {
        if (err.status !== 404 && err.status !== 403) throw err;
      }
    }
    if (!tab) {
      const ou = target.sourceOrgUnitId || courseId;
      tab = {
        id: `tab:${target.topicId}`,
        title: 'Syllabus',
        modulePath: [],
        fileUrl: `/d2l/api/le/${le}/${ou}/content/topics/${target.topicId}/file`,
        fileHref: null,
        url: new URL(link.href, origin).href,
        updatedAt: null,
      };
    }
  }
  return readSyllabusTabText(client, tab, readTab, tab.fileHref || link.href);
}

// The course overview is where many instructors attach the syllabus.
export function normalizeOverview(overview, courseId, le) {
  if (!overview) return null;
  return {
    text: richText(overview.Description),
    hasAttachment: Boolean(overview.HasAttachment),
    fileUrl: overview.HasAttachment ? `/d2l/api/le/${le}/${courseId}/overview/attachment` : null,
  };
}

export async function syncCurrentCourses(client, { origin, now = new Date(), onProgress = () => {} } = {}) {
  const started = Date.now();
  const versions = await discoverVersions(client);
  const { lp, le } = versions;
  const errors = [];

  onProgress({ message: 'Reading your enrollments…', done: 0, total: null });
  const me = await client.getJson(`/d2l/api/lp/${lp}/users/whoami`);
  const enrollments = (await client.getAll(`/d2l/api/lp/${lp}/enrollments/myenrollments/?orgUnitTypeId=3`)).map(normalizeEnrollment);

  const candidates = enrollments.filter((c) => c.isActive && c.canAccess && c.typeId === 3);
  const needDetails = candidates.filter((c) => !c.startDate && !c.endDate);
  if (needDetails.length) onProgress({ message: `Checking dates for ${needDetails.length} courses…`, done: 0, total: null });
  const details = new Map();
  await mapWithLimit(needDetails, MAX_CONCURRENT_REQUESTS, async (course) => {
    try {
      details.set(course.id, await client.getJson(`/d2l/api/lp/${lp}/courses/${course.id}`));
    } catch (err) {
      errors.push({ courseId: course.id, section: 'course details', status: err.status ?? null, message: err.message });
    }
  });

  const courses = enrollments.map((course) => {
    const full = withCourseDetails(course, details.get(course.id));
    return { ...full, ...classifyCourse(full, now) };
  });
  const current = courses.filter((c) => c.current);

  const calendarStart = new Date(now.getTime() - CALENDAR_PAST_DAYS * DAY_MS).toISOString();
  const calendarEnd = new Date(now.getTime() + CALENDAR_FUTURE_DAYS * DAY_MS).toISOString();

  let completed = 0;
  onProgress({ message: 'Syncing your courses…', done: 0, total: current.length });
  const perCourse = await mapWithLimit(current, 1, async (course) => {
    const base = `/d2l/api/le/${le}/${course.id}`;
    const [assignments, quizzes, announcements, content, events, grades, overview] = await Promise.all([
      section(errors, course.id, 'assignments', async () =>
        (await client.getAll(`${base}/dropbox/folders/`)).map((f) => normalizeAssignment(f, course.id, origin))),
      section(errors, course.id, 'quizzes', async () =>
        (await client.getAll(`${base}/quizzes/`)).map((q) => normalizeQuiz(q, course.id, origin))),
      section(errors, course.id, 'announcements', async () =>
        (await client.getAll(`${base}/news/`)).map((n) => normalizeAnnouncement(n, course.id, origin))),
      section(errors, course.id, 'content', async () =>
        flattenToc(await client.getJson(`${base}/content/toc`), course.id, origin).map((t) => ({
          ...t,
          fileUrl: t.fileUrl?.replace('{le}', le) ?? null,
        }))),
      section(errors, course.id, 'calendar', async () =>
        (await client.getAll(
          withQuery(`${base}/calendar/events/myEvents/`, { startDateTime: calendarStart, endDateTime: calendarEnd }),
        )).map((e) => normalizeCalendarEvent(e, course.id, origin))),
      section(errors, course.id, 'grades', async () =>
        (await client.getAll(`${base}/grades/values/myGradeValues/`)).map(normalizeGrade)),
      section(errors, course.id, 'overview', async () => normalizeOverview(await client.getJson(`${base}/overview`), course.id, le), { empty: null, missingOk: true }),
    ]);
    completed++;
    onProgress({ message: `Synced ${shortCourseLabel(course)} (${completed} of ${current.length})…`, done: completed, total: current.length });
    return { courseId: course.id, assignments, quizzes, announcements, content, events, grades, overview };
  });
  onProgress({ message: 'Saving…', done: current.length, total: current.length });

  return {
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    origin,
    versions,
    authMode: client.authMode,
    user: { firstName: me.FirstName ?? null },
    courses,
    data: perCourse,
    errors,
    requestLog: client.requestLog,
  };
}

// ---------- Entry point, run inside a Brightspace tab ----------

// Firefox wraps bytes from content.fetch. Spreading a subarray looks up constructor across
// compartments and throws "Permission denied to access property constructor".
// A PowerPoint or Word file is a zip. The pictures make it large, and a text read never unpacks them.
export function fileByteLimit(bytes) {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  return zip ? DECK_FILE_BYTES : MAX_FILE_BYTES;
}

async function ownBytes(source) {
  const bytes = new Uint8Array(source.length);
  const step = 1_048_576;
  for (let i = 0; i < source.length; i += step) {
    const end = Math.min(i + step, source.length);
    for (let j = i; j < end; j++) bytes[j] = source[j];
    if (end < source.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return bytes;
}

export function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    const codes = new Array(end - i);
    for (let j = i; j < end; j++) codes[j - i] = bytes[j];
    binary += String.fromCharCode.apply(null, codes);
  }
  return btoa(binary);
}

// Chrome content scripts fetch as the page. Firefox content scripts fetch as the extension, so use
// content.fetch there; its arguments must be cloned into the page and its abort signal stays on our side.
function fetchAsPage() {
  if (typeof content === 'undefined' || typeof content?.fetch !== 'function' || typeof cloneInto !== 'function') return fetch;
  return (url, { signal, ...init } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      content.fetch(url, cloneInto(init, content)).then(resolve, reject);
    });
}

const DOWNLOAD_PATHS = [/^\/d2l\/api\/le\/[\d.]+\/\d+\/content\/topics\/\d+\/file$/, /^\/d2l\/api\/le\/[\d.]+\/\d+\/overview\/attachment$/, COURSE_FILE_PATH];
const PICTURE_EDGE = 1280;
let heldFile = null;

async function shrinkPicture(bytes, mediaType) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    if (bytes.length > 400_000) return null;
    return { mediaType, data: toBase64(bytes) };
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
  const scale = Math.min(1, PICTURE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
  return { mediaType: 'image/jpeg', data: toBase64(new Uint8Array(await blob.arrayBuffer())) };
}

// The navbar is drawn by the course page, so a fetch never includes the Syllabus tab. A background tab loads each course and reads it.
function pageSyllabusReader() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;
  const ask = async (body) => {
    const reply = await chrome.runtime.sendMessage({ type: 'boilerspace-syllabus', ...body });
    if (!reply || reply.error) throw new Error(reply?.error || 'The syllabus reader did not answer.');
    return reply;
  };
  return {
    links: async (courseId) => (await ask({ phase: 'links', courseId, origin: location.origin }))?.hrefs ?? [],
    page: async (href) => {
      const reply = await ask({ phase: 'page', href, origin: location.origin });
      return reply.notFound ? { notFound: true } : reply.text ?? '';
    },
  };
}

export async function runInPage(action, args = {}, { onProgress = () => {} } = {}) {
  const xsrfToken =
    args.xsrfToken ??
    localStorage.getItem('XSRF.Token') ??
    document.querySelector('meta[name="d2l-xsrf-token"]')?.getAttribute('content') ??
    null;
  const client = createClient({ origin: location.origin, fetchImpl: fetchAsPage(), xsrfToken });
  try {
    if (action === 'sync') {
      return { ok: true, result: await syncCurrentCourses(client, { origin: location.origin, onProgress }) };
    }
    if (action === 'discover-syllabus') {
      const versions = args.versions ?? await discoverVersions(client);
      return { ok: true, result: await findSyllabusTab(client, {
        courseId: args.courseId, ...versions, origin: location.origin,
        pageLinks: syllabusHrefsInDocument(globalThis.document), readTab: pageSyllabusReader(),
      }) };
    }
    if (action === 'read-quiz') {
      const versions = await discoverVersions(client);
      const result = await readQuiz(client, { ...args, le: args.le ?? versions.le, origin: location.origin, now: new Date() });
      return { ok: true, result };
    }
    if (action === 'download') {
      if (!DOWNLOAD_PATHS.some((pattern) => pattern.test(args.path ?? ''))) {
        throw new BrightspaceError('Refusing to download from an unexpected path.', { path: args.path });
      }
      const file = !args.refresh && heldFile?.path === args.path ? heldFile.file : await client.getFile(args.path);
      heldFile = { path: args.path, file };
      const isPdf = file.bytes[0] === 0x25 && file.bytes[1] === 0x50 && file.bytes[2] === 0x44 && file.bytes[3] === 0x46;
      // Slide decks are mostly images. Read the text here and send that back, instead of a base64 copy of the whole file.
      // The import stays inside this branch so a PDF download does not depend on it.
      if (!isPdf) {
        const { extractText, slidePictures } = await import('./extract.js');
        const extracted = await extractText({ ...file, fileName: file.fileName || args.fileName });
        const images = [];
        if (args.seeImages && args.location && extracted.kind === 'pptx') {
          for (const picture of slidePictures(file.bytes, args.location)) {
            try {
              const shrunk = await shrinkPicture(picture.bytes, picture.mediaType);
              if (shrunk) images.push(shrunk);
            } catch {
              /* a picture that will not decode is left out */
            }
          }
        }
        return {
          ok: true,
          result: {
            kind: extracted.kind,
            pages: extracted.pages,
            warning: extracted.warning,
            contentType: file.contentType,
            fileName: file.fileName || args.fileName,
            ...(images.length ? { images } : {}),
          },
        };
      }
      return { ok: true, result: { base64: toBase64(file.bytes), contentType: file.contentType, fileName: file.fileName } };
    }
    throw new BrightspaceError(`Unknown action ${action}`);
  } catch (err) {
    return { ok: false, error: err.message, status: err.status ?? null, path: err.path ?? null, requestLog: client.requestLog };
  }
}
