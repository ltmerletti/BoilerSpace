// Brightspace (D2L Valence) client for Purdue. Runs inside a purdue.brightspace.com tab so
// every request carries the student's own session. Read-only: it only sends GETs, plus the
// token request that Brightspace's own web components use.

import { shortCourseLabel } from './courses.js';

export const DEFAULT_VERSIONS = { lp: '1.62', le: '1.96' };

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FILE_BYTES = 25_000_000;
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

  async function request(path) {
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const res = await fetchImpl(origin + path, {
        credentials: 'include',
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  async function getFile(path) {
    const res = await request(path);
    const contentType = res.headers.get('content-type') ?? '';
    const view = new Uint8Array(await res.arrayBuffer());
    const bytes = new Uint8Array(view.length);
    bytes.set(view);
    if (bytes.length > MAX_FILE_BYTES) throw new BrightspaceError(`File is larger than ${MAX_FILE_BYTES / 1_000_000} MB.`, { path });
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

  return { getJson, getAll, getFile, requestLog, get authMode() { return bearer ? 'token' : 'cookie'; } };
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

  const perCourse = await mapWithLimit(current, 1, async (course, index) => {
    onProgress({ message: `Syncing ${shortCourseLabel(course)} (${index + 1} of ${current.length})…`, done: index, total: current.length });
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

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
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
    if (action === 'download') {
      if (!DOWNLOAD_PATHS.some((pattern) => pattern.test(args.path ?? ''))) {
        throw new BrightspaceError('Refusing to download from an unexpected path.', { path: args.path });
      }
      const file = await client.getFile(args.path);
      return { ok: true, result: { base64: toBase64(file.bytes), contentType: file.contentType, fileName: file.fileName } };
    }
    throw new BrightspaceError(`Unknown action ${action}`);
  } catch (err) {
    return { ok: false, error: err.message, status: err.status ?? null, path: err.path ?? null, requestLog: client.requestLog };
  }
}
