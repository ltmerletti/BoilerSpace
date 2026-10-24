import { chromium } from 'playwright';
import { Cookie } from 'tough-cookie';
import { ORIGIN, allowedPath } from './config.mjs';
import { CompanionError } from './errors.mjs';
import { snapshotSyllabus } from '../../extension/lib/syllabus-scan.js';

// Only explicit syllabus reads use this isolated renderer. Discussion refreshes
// never launch a browser, and no personal browser/profile is contacted.
export function syllabusBrowser(session, { launch = chromium.launchPersistentContext.bind(chromium) } = {}) {
  const render = async (href, linksOnly = false) => {
    const url = new URL(href, ORIGIN);
    if (url.origin !== ORIGIN || !/^\/d2l\/(?:home\/\d+|common\/dialogs\/quickLink\/quickLink\.d2l|le\/content\/\d+\/)/.test(url.pathname) && !url.pathname.startsWith('/content/')) throw new CompanionError('blocked-request', 'Only a discovered Purdue syllabus page can be rendered.');
    await session.load();
    const context = await launch('', { headless: true, serviceWorkers: 'block' });
    // An ephemeral profile avoids sharing Chromium's profile lock across clients.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; context.close().catch(() => {}); }, 60000);
    try {
      const cookies = await session.jar.getCookies(ORIGIN);
      await context.addCookies(cookies.map(cookie => ({ name: cookie.key, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
        ...(cookie.expires instanceof Date && Number.isFinite(cookie.expires.getTime()) ? { expires: Math.floor(cookie.expires.getTime() / 1000) } : {}) })));
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/*', async route => {
        const target = new URL(route.request().url());
        if (['https://s.brightspace.com', 'https://code.iconify.design'].includes(target.origin) && route.request().method() === 'GET' && ['script', 'stylesheet', 'font', 'image'].includes(route.request().resourceType())) return route.fallback();
        if (![ORIGIN, 'https://purdue.simplesyllabus.com'].includes(target.origin) || /\/(?:grades|submissions)(?:\/|$)/i.test(target.pathname)) return route.abort();
        if (target.origin === ORIGIN && target.pathname === '/d2l/api/oslo/batch') {
          let body;
          try { body = route.request().postDataJSON(); } catch { /* Rejected below. */ }
          // OSLO loads the LTI web component, not arbitrary batched API calls.
          if (route.request().method() !== 'POST' || !body || Object.keys(body).length !== 1 || !Array.isArray(body.resources) || body.resources.length !== 1 || body.resources[0] !== '@d2l\\lti-components\\lti-components') return route.abort();
          return route.fallback();
        }
        if (target.origin === ORIGIN && ['fetch', 'xhr'].includes(route.request().resourceType())) {
          try { allowedPath(target.href); } catch { return route.abort(); }
        }
        return route.fallback();
      });
      const page = context.pages()[0] ?? await context.newPage();
      // Simple Syllabus's CDN rejects Chromium's headless product token.
      // Keep the browser version while identifying this read as desktop Chrome.
      const agent = await page.evaluate(() => navigator.userAgent);
      await context.setExtraHTTPHeaders({ 'User-Agent': agent.replace('HeadlessChrome/', 'Chrome/') });
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const snapshots = [];
        for (const frame of context.pages().flatMap(page => page.frames())) {
          if (!['https://purdue.brightspace.com', 'https://purdue.simplesyllabus.com'].includes(new URL(frame.url() || ORIGIN).origin)) continue;
          snapshots.push(await frame.evaluate(snapshotSyllabus).catch(() => null));
        }
        if (linksOnly && snapshots.some(snapshot => snapshot?.navReady)) return [...new Set(snapshots.flatMap(snapshot => snapshot?.hrefs ?? []))];
        if (snapshots.some(snapshot => snapshot?.notFound)) return { notFound: true };
        const text = snapshots.filter(snapshot => snapshot?.contentReady).map(snapshot => snapshot.text).sort((a, b) => b.length - a.length)[0];
        if (text?.length >= 500) return text;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new CompanionError('syllabus-unavailable', 'The syllabus portal did not return readable text. Run login to renew the Purdue session, or choose an uploaded syllabus file.');
    } catch (error) {
      if (timedOut) throw new CompanionError('syllabus-timeout', 'The syllabus renderer exceeded its one-minute limit. Try again or read an uploaded syllabus.');
      throw error;
    } finally {
      clearTimeout(timer);
      try {
        for (const cookie of await context.cookies(ORIGIN).catch(() => [])) await session.jar.setCookie(new Cookie({ key: cookie.name, value: cookie.value, domain: cookie.domain.replace(/^\./, ''),
          path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, hostOnly: !cookie.domain.startsWith('.'), ...(cookie.expires > 0 ? { expires: new Date(cookie.expires * 1000) } : {}) }), ORIGIN);
        await session.save();
      } finally { await context.close(); }
    }
  };
  return { links: courseId => render(`/d2l/home/${courseId}`, true), page: href => render(href) };
}
