import { DISCUSSION_BATCH_SIZE, DISCUSSION_SITES } from './discussions.js';
import { clearDiscussionAuth, edSessionToken, piazzaCsrf, reconnectMessage } from './discussion-auth.js';

export async function readDiscussionSite({ platform, remoteId, discover = false, limit = DISCUSSION_BATCH_SIZE, offset = 0, knownVersions = {}, name }) {
  try {
    if (!DISCUSSION_SITES[platform] || !(await chrome.permissions.contains({ origins: DISCUSSION_SITES[platform] }))) throw new Error('Allow discussion site access by reconnecting in Settings.');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const json = async (url, options = {}) => {
      let response;
      for (let attempt = 0; attempt < 4; attempt++) {
        response = await fetch(url, { credentials: platform === 'ed' ? 'omit' : 'include', ...options, signal: AbortSignal.timeout(20_000) });
        if (response.status !== 429 && response.status < 500) break;
        if (attempt < 3) await sleep(Math.min(30_000, Math.max(Number(response.headers.get('retry-after')) * 1000 || 0, 2000 * 2 ** attempt)));
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          await clearDiscussionAuth(platform);
          throw new Error(reconnectMessage(platform));
        }
        throw new Error(`Discussion request failed: HTTP ${response.status}`);
      }
      try { return await response.json(); } catch {
        await clearDiscussionAuth(platform);
        throw new Error(reconnectMessage(platform));
      }
    };
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid discussion cursor.');
    const started = Date.now();
    // Short checkpoints preserve progress across background worker interruptions.
    const threads = [], errors = [], seenIds = [], pageIds = [], versions = {};
    const readBatch = async (items, idOf, versionOf, isPublic, read) => {
      for (const item of items) {
        if (Date.now() - started > 10_000) break;
        const id = String(idOf(item));
        if (isPublic(item)) {
          const version = versionOf(item);
          if (!version || knownVersions[id] !== version) {
            try { threads.push(await read(item)); }
            catch (error) { errors.push(`Post #${item.number ?? item.nr}: ${error.message}`); break; }
            await sleep(platform === 'piazza' ? 1000 : 120);
          }
          seenIds.push(id);
          versions[id] = version;
        }
        pageIds.push(id);
      }
    };
    if (platform === 'ed') {
      const token = await edSessionToken(discover);
      const headers = { 'x-token': token };
      const user = await json('https://us.edstem.org/api/user', { headers });
      const courses = (user.courses ?? []).map((e) => e.course).filter((c) => c?.status === 'active').map((c) => ({ remoteId: String(c.id), name: c.name || c.code, code: c.code }));
      if (discover) return { courses };
      if (!/^\d+$/.test(remoteId) || !courses.some((c) => c.remoteId === remoteId)) throw new Error('This Ed course is not an active course in your signed-in account.');
      const feed = await json(`https://us.edstem.org/api/courses/${remoteId}/threads?limit=${limit}&sort=new&offset=${offset}`, { headers });
      const items = feed.threads ?? [];
      await readBatch(items, (t) => t.id,
        (t) => JSON.stringify([t.updated_at, t.reply_count, t.answer_count, t.comment_count, t.title, t.content, t.is_endorsed, t.is_pinned]),
        (t) => !t.is_private && !t.deleted_at,
        async (thread) => {
          const data = await json(`https://us.edstem.org/api/threads/${thread.id}`, { headers });
          // Return role labels needed for citations, without account profiles or credentials.
          return { thread: data.thread, users: (data.users ?? []).map((u) => ({ id: u.id, course_role: u.course_role })) };
        });
      return { name: courses.find((c) => c.remoteId === remoteId).name, threads, errors, seenIds, pageIds, versions,
        nextOffset: offset + pageIds.length, hasMore: items.length > 0 };

    }
    if (remoteId && !/^[a-z0-9]+$/i.test(remoteId)) throw new Error('Enter a valid Piazza class link.');
    const response = await fetch(remoteId ? `https://piazza.com/class/${remoteId}` : 'https://piazza.com/',
      { credentials: 'include', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? reconnectMessage('piazza') : `Piazza request failed: HTTP ${response.status}`);
    const csrf = piazzaCsrf(await response.text());
    const call = async (method, params) => {
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        data = await json(`https://piazza.com/logic/api?method=${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'csrf-token': csrf }, body: JSON.stringify({ method, params }) });
        if (!/too fast|rate.limit/i.test(data.error ?? '') || attempt === 3) break;
        await sleep(2000 * 2 ** attempt);
      }
      if (data.error || !data.result) throw new Error(/login|auth|valid/i.test(data.error ?? '') ? reconnectMessage('piazza') : `Piazza: ${data.error ?? 'No discussion data returned.'}`);
      return data.result;
    };
    if (discover) {
      const account = await call('user.status', {});
      const courses = (account.networks ?? []).filter(course => /^[a-z0-9]+$/i.test(course.id ?? ''))
        .map(course => ({ remoteId: String(course.id), name: course.course_number || course.name || `Piazza ${course.id}` }));
      return { courses };
    }
    if (!remoteId) throw new Error('Choose a Piazza class to sync.');
    const feed = await call('network.get_my_feed', { nid: remoteId, limit, offset, sort: 'updated' });
    const items = feed.feed ?? [];
    await readBatch(items, (t) => t.nr,
      (t) => JSON.stringify([t.version, t.main_version, t.modified, t.updated, t.tags]),
      (t) => !(t.tags ?? []).includes('private'),
      (item) => call('content.get', { nid: remoteId, cid: String(item.nr), student_view: null }));
    return { name: name || `Piazza ${remoteId}`,
      threads, errors, seenIds, pageIds, versions, nextOffset: offset + pageIds.length,
      hasMore: pageIds.length < items.length || (items.length > 0 && feed.more === true) };

  } catch (error) {
    return { error: error.message };
  }
}
