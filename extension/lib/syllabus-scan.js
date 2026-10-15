// Reads the Syllabus tab from a loaded Brightspace page.
// Everything lives inside the function so the background page can run that function in the tab.

export function snapshotSyllabus(courseId, root) {
  const nameIsSyllabus = (value) => /^syllabus$/i.test(String(value ?? '').replace(/\s+/g, ' ').trim());
  const framedName = (href) => {
    const framed = /[?&]framedName=([^&#"']*)/i.exec(String(href ?? ''))?.[1] ?? '';
    if (!framed) return '';
    try {
      return decodeURIComponent(framed.replace(/\+/g, ' '));
    } catch {
      return framed;
    }
  };
  const topicTarget = (href, origin) => {
    let url;
    try {
      url = new URL(href, origin);
    } catch {
      return null;
    }
    if (/quickLink\.d2l$/i.test(url.pathname)) {
      const type = (url.searchParams.get('type') ?? '').toLowerCase();
      if (type && type !== 'content') return null;
      const code = url.searchParams.get('code') ?? url.searchParams.get('rcode') ?? '';
      const topicId = /-(\d+)$/.exec(code)?.[1] ?? (/^\d+$/.test(code) ? code : null);
      if (!topicId) return null;
      return { topicId: Number(topicId), orgUnitId: Number(url.searchParams.get('ou')) || null };
    }
    const view = /\/content\/(\d+)\/viewContent\/(\d+)\/View$/i.exec(url.pathname);
    if (view) return { topicId: Number(view[2]), orgUnitId: Number(view[1]) };
    return null;
  };
  const documentText = (doc) => {
    let best = '';
    let ready = false;
    const visit = (node, depth) => {
      if (!node || depth > 5) return;
      let text = '';
      try {
        const path = node.location?.pathname ?? '';
        const file = /^\/content\/enforced\//.test(path);
        const container = file ? node.body : /\/viewContent\/\d+\/View$/i.test(path) ? node.querySelector?.('main, [role="main"], .d2l-page-main') : null;
        text = (container?.innerText || '').replace(/\s+/g, ' ').trim();
        if (container?.querySelector?.('[aria-busy="true"], d2l-loading-spinner') || /^(loading|please wait)[.…\s]*$/i.test(text)) text = '';
        if (text.length > best.length) {
          best = text;
          ready = node.readyState === 'complete';
        }
      } catch {
        return;
      }
      let frames;
      try {
        frames = node.querySelectorAll('iframe, frame');
      } catch {
        return;
      }
      for (const frame of frames) {
        try {
          visit(frame.contentDocument, depth + 1);
        } catch {
          // a frame from another origin stays unread
        }
      }
    };
    visit(doc, 0);
    return { text: best, contentReady: ready };
  };

  const doc = root ?? globalThis.document;
  const origin = doc?.location?.origin ?? globalThis.location?.origin ?? 'https://purdue.brightspace.com';
  const hrefs = [];
  const seen = new Set();
  const add = (href, text = '') => {
    href = String(href ?? '').replace(/&amp;/g, '&');
    if (!href || seen.has(href)) return;
    if (!nameIsSyllabus(text) && !nameIsSyllabus(framedName(href))) return;
    const target = topicTarget(href, origin);
    if (!target) return;
    if (courseId != null && target.orgUnitId && target.orgUnitId !== Number(courseId)) return;
    seen.add(href);
    hrefs.push(href);
  };
  const visit = (node) => {
    if (!node?.querySelectorAll) return;
    for (const el of node.querySelectorAll('*')) {
      const href = el.getAttribute?.('href') || (typeof el.href === 'string' ? el.href : '');
      const text = el.getAttribute?.('text') || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.textContent || '';
      add(href, text);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(doc);
  const content = documentText(doc);
  const navReady = doc?.readyState === 'complete' && Boolean(doc.querySelector?.('d2l-navigation, d2l-navigation-main-header, .d2l-navigation-s-header, nav, [role="navigation"]'));
  return { hrefs, text: content.text.slice(0, 120_000), contentReady: content.contentReady, navReady };
}
