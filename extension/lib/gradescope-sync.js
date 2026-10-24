import { GRADESCOPE_ORIGIN, GRADESCOPE_SITES, GRADESCOPE_REFRESH_MS, currentGradescopeCourse, linkGradescopeCourse, parseGradescopeAssignments, parseGradescopeCourses } from './gradescope.js';

const authenticationError = () => Object.assign(new Error('Sign in to Gradescope and reconnect.'), { needsReconnect: true });

export async function fetchGradescopePage(path, fetcher = fetch) {
  if (!/^\/(?:account|courses\/\d+)\/?$/.test(path)) throw new Error('Only Gradescope course lists can be read.');
  const response = await fetcher(`${GRADESCOPE_ORIGIN}${path}`, { credentials: 'include', signal: AbortSignal.timeout(30_000) });
  if ((response.status === 401 || (response.status === 403 && path === '/account')) || /\/(?:login|signin|auth)(?:\/|$)/.test(new URL(response.url || `${GRADESCOPE_ORIGIN}${path}`).pathname)) throw authenticationError();
  if (!response.ok) throw new Error(`Gradescope is temporarily unavailable (HTTP ${response.status}). Try again later.`);
  if (new URL(response.url || GRADESCOPE_ORIGIN).origin !== GRADESCOPE_ORIGIN) throw authenticationError();
  const html = await response.text();
  if (/<form[^>]+(?:action=["'][^"']*\/login|id=["'](?:new_user|login))/i.test(html) && !html.includes('courseList') && !html.includes('assignments-student-table')) throw authenticationError();
  return html;
}

export function createGradescopeSync(readPage = fetchGradescopePage, now = () => new Date(), { storage, hasAccess = origins => chrome.permissions.contains({ origins }) } = {}) {
  let queue = Promise.resolve();
  const pending = new Map();
  return function handleRequest(message) {
    const key = JSON.stringify([message.action, message.sourceId, message.courseId, Boolean(message.force)]);
    if (pending.has(key)) return pending.get(key);
    const task = queue.catch(() => {}).then(() => perform(message)).finally(() => pending.delete(key));
    pending.set(key, task);
    queue = task;
    return task;
  };
  async function perform({ action, sourceId, courseId, force = false }) {
    const local = storage ?? chrome.storage.local;
    if (action === 'disconnect') { await local.remove('gradescope'); return null; }
    if (!(await hasAccess(GRADESCOPE_SITES))) {
      const { gradescope } = await local.get('gradescope');
      if (gradescope) await local.set({ gradescope: { ...gradescope, status: 'error', needsReconnect: true, error: 'Allow Gradescope access to reconnect.' } });
      throw Object.assign(new Error('Allow Gradescope access to connect.'), { needsReconnect: true });
    }
    const all = await local.get(['gradescope', 'snapshot']);
    const data = all.gradescope;
    if (action === 'link') {
      const course = data?.courses.find(course => course.id === sourceId);
      if (!course) throw new Error('Gradescope course not found.');
      if (courseId !== null && !all.snapshot?.courses.some(course => course.id === courseId && course.current)) throw new Error('Choose a current Brightspace course.');
      course.courseId = courseId;
      course.linkOrigin = 'manual';
      await local.set({ gradescope: data });
      return data;
    }
    if (!['connect', 'sync'].includes(action)) throw new Error('Unknown Gradescope action.');
    if (!data && action === 'sync') return null;
    if (action === 'sync' && !force && Date.now() - Date.parse(data.lastAttemptAt) < GRADESCOPE_REFRESH_MS) {
      const links = JSON.stringify(data.courses.map(course => course.courseId));
      data.courses.forEach(course => linkGradescopeCourse(course, all.snapshot?.courses ?? []));
      if (links !== JSON.stringify(data.courses.map(course => course.courseId))) await local.set({ gradescope: data });
      return data;
    }
    const next = data ?? { generation: crypto.randomUUID(), courses: [] };
    const generation = next.generation;
    const save = async () => {
      if (local.compareAndSet) return local.compareAndSet('gradescope', generation, next);
      const current = (await local.get('gradescope')).gradescope;
      if (current?.generation !== generation) throw new Error('Gradescope sync was cancelled because its saved data was cleared.');
      await local.set({ gradescope: next });
    };
    next.lastAttemptAt = new Date().toISOString();
    next.status = 'syncing';
    next.error = null;
    if (local.compareAndSet) await local.compareAndSet('gradescope', data?.generation, next);
    else await local.set({ gradescope: next });
    try {
      const discovered = parseGradescopeCourses(await readPage('/account'));
      const current = discovered.filter(course => currentGradescopeCourse(course, all.snapshot?.courses ?? [], now()));
      const previous = new Map(next.courses.map(course => [course.id, course]));
      next.courses = current.map(course => linkGradescopeCourse({ ...previous.get(course.id), ...course, assignments: previous.get(course.id)?.assignments ?? [] }, all.snapshot?.courses ?? []));
      let hadError = false;
      for (const course of next.courses) {
        try {
          course.assignments = parseGradescopeAssignments(await readPage(`/courses/${course.remoteId}`), course);
          course.lastSyncedAt = new Date().toISOString();
          course.error = null;
          next.needsReconnect = false;
        } catch (error) {
          course.error = error.message;
          hadError = true;
          if (error.needsReconnect) throw error;
        }
        await save();
      }
      next.status = hadError ? 'error' : 'done';
      next.error = hadError ? 'Some Gradescope courses could not be updated. Saved assignments are kept; retry the update.' : null;
      next.needsReconnect = false;
      if (!hadError) next.lastSyncedAt = new Date().toISOString();
    } catch (error) {
      next.status = 'error';
      next.error = error.message;
      next.needsReconnect = Boolean(error.needsReconnect);
    }
    await save();
    if (action === 'connect' && next.needsReconnect) throw authenticationError();
    return next;
  }
}

export const handleGradescopeRequest = createGradescopeSync();
