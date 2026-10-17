// Serialized into the signed-in site's MAIN world. Session tokens stay in that page.
export async function readDiscussionSite({ platform, remoteId, discover = false, limit = 30, offset = 0, knownVersions = {} }) {
  try {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const json = async (url, options = {}) => {
      let response;
      for (let attempt = 0; attempt < 4; attempt++) {
        response = await fetch(url, { credentials: platform === 'ed' ? 'omit' : 'include', ...options, signal: AbortSignal.timeout(20_000) });
        if (response.status !== 429 && response.status < 500) break;
        if (attempt < 3) await sleep(Math.min(30_000, Math.max(Number(response.headers.get('retry-after')) * 1000 || 0, 2000 * 2 ** attempt)));
      }
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? `Sign into ${platform === 'ed' ? 'Ed' : 'Piazza'} in this browser, then retry.` : `Discussion request failed: HTTP ${response.status}`);
      try { return await response.json(); } catch { throw new Error(`Sign into ${platform === 'ed' ? 'Ed' : 'Piazza'} in this browser, then retry.`); }
    };
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid discussion cursor.');
    const started = Date.now();
    // Finish each message promptly, saving its cursor before the next batch.
    const threads = [], errors = [], seenIds = [], pageIds = [], versions = {};
    const readBatch = async (items, idOf, versionOf, isPublic, read) => {
      for (const item of items) {
        if (Date.now() - started > 60_000) break;
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
      if (location.hostname !== 'edstem.org' && location.hostname !== 'us.edstem.org') throw new Error('Open Ed in this browser first.');
      const token = localStorage.getItem('authToken:us') || localStorage.getItem('authToken');
      if (!token) throw new Error('Sign into US Ed in this browser, then retry.');
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
          // Session tokens and author profiles never leave the signed-in page.
          return { thread: data.thread, users: (data.users ?? []).map((u) => ({ id: u.id, course_role: u.course_role })) };
        });
      return { name: courses.find((c) => c.remoteId === remoteId).name, threads, errors, seenIds, pageIds, versions,
        nextOffset: offset + pageIds.length, hasMore: items.length > 0 };

    }
    if (platform !== 'piazza' || location.hostname !== 'piazza.com') throw new Error('Open Piazza in this browser first.');
    let csrf;
    for (let i = 0; i < 40 && !csrf; i++) {
      csrf = document.querySelector('meta[name="csrf_token"]')?.content || window.CSRF_TOKEN;
      if (!csrf) await sleep(250);
    }
    if (!csrf) throw new Error('Sign into Piazza in this browser, then retry.');
    if (discover) {
      const courses = new Map();
      for (let attempt = 0; attempt < 40; attempt++) {
        for (const anchor of document.querySelectorAll('a[href*="/class/"]')) {
          const target = new URL(anchor.href, location.href);
          const match = target.hostname === 'piazza.com' && /^\/class\/([a-z0-9]+)(?:\/|$)/i.exec(target.pathname);
          const name = anchor.textContent?.trim();
          if (match && name) courses.set(match[1], { remoteId: match[1], name });
        }
        const current = /^\/class\/([a-z0-9]+)(?:\/|$)/i.exec(location.pathname);
        const name = document.getElementById('topbar_current_class_number')?.textContent?.trim();
        if (current && name) courses.set(current[1], { remoteId: current[1], name });
        if (courses.size) break;
        await sleep(250);
      }
      return { courses: [...courses.values()] };
    }
    if (!/^[a-z0-9]+$/i.test(remoteId)) throw new Error('Open a Piazza class in this browser first.');
    const call = async (method, params) => {
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        data = await json(`/logic/api?method=${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'csrf-token': csrf }, body: JSON.stringify({ method, params }) });
        if (!/too fast|rate.limit/i.test(data.error ?? '') || attempt === 3) break;
        await sleep(2000 * 2 ** attempt);
      }
      if (data.error || !data.result) throw new Error(/login|auth|valid/i.test(data.error ?? '') ? 'Sign into Piazza in this browser, then retry.' : `Piazza: ${data.error ?? 'No discussion data returned.'}`);
      return data.result;
    };
    const feed = await call('network.get_my_feed', { nid: remoteId, limit, offset, sort: 'updated' });
    const items = feed.feed ?? [];
    await readBatch(items, (t) => t.nr,
      (t) => JSON.stringify([t.version, t.main_version, t.modified, t.updated, t.tags]),
      (t) => !(t.tags ?? []).includes('private'),
      (item) => call('content.get', { nid: remoteId, cid: String(item.nr), student_view: null }));
    const matchingPage = location.pathname === `/class/${remoteId}`;
    return { name: matchingPage && document.getElementById('topbar_current_class_number')?.textContent?.trim() || `Piazza ${remoteId}`,
      threads, errors, seenIds, pageIds, versions, nextOffset: offset + pageIds.length,
      hasMore: pageIds.length < items.length || (items.length > 0 && feed.more === true) };

  } catch (error) {
    return { error: error.message };
  }
}
