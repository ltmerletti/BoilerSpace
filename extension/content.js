// Runs on purdue.brightspace.com pages: adds the BoilerSpace button to the navbar, shows the panel
// beside the page, and does Brightspace work for the extension using this page's session.
// Stays off entirely on quiz attempt pages.

(() => {
  // A background tab opened to read another course's syllabus, or a frame inside one.
  try {
    if (location.hash.includes('boilerspace-scan') || sessionStorage.getItem('boilerspace-scan') === '1') return;
  } catch {
    // sessionStorage can be blocked; the hash still marks a scan tab
  }
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }
  if (window.__boilerspaceLoaded) return;
  window.__boilerspaceLoaded = true;
  if (location.pathname.startsWith('/d2l/lms/quizzing/user/attempt/') || location.pathname.startsWith('/d2l/login')) return;

  const extensionUrl = (path) => chrome.runtime.getURL(path);
  const extensionOrigin = new URL(extensionUrl('')).origin;
  const loadLib = (name) => import(extensionUrl(`lib/${name}`));
  const NAV_WAIT_MS = 15_000;
  const AUTO_SYNC_DELAY_MS = 1500;
  const DEFAULT_WIDTH = 400;
  const MIN_WIDTH = 340;
  const MAX_WIDTH = 720;
  // Below this much room for Brightspace, the panel covers the page instead of pushing it over.
  const MIN_PAGE_WIDTH = 760;

  // ---------- Brightspace work for the extension ----------

  async function xsrfToken(fromExtension) {
    if (fromExtension) return fromExtension;
    const local = localStorage.getItem('XSRF.Token') ?? document.querySelector('meta[name="d2l-xsrf-token"]')?.getAttribute('content');
    if (local) return local;
    const reply = await chrome.runtime.sendMessage({ type: 'boilerspace-xsrf' }).catch(() => null);
    return reply?.token ?? null;
  }

  async function pageWork(action, args = {}) {
    const token = await xsrfToken(args.xsrfToken);
    const sync = await loadLib('page-sync.js');
    if (action === 'sync') {
      return sync.syncHere({ xsrfToken: token });
    }
    if (action === 'discover-syllabus') return sync.discoverSyllabusHere({ ...args, xsrfToken: token });
    if (action === 'download') return sync.downloadHere(args.path, { xsrfToken: token, seeImages: args.seeImages, location: args.location, refresh: args.refresh });
    if (action === 'read-quiz') return sync.readQuizHere({ ...args, xsrfToken: token });
    throw new Error(`Unknown request ${action}`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const reply = (promise) => {
      promise.then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
      return true;
    };
    switch (message?.type) {
      case 'boilerspace-ping':
        sendResponse({ ok: true });
        return false;
      case 'boilerspace-sync':
        return reply(pageWork('sync', message));
      case 'boilerspace-download':
        return reply(pageWork('download', message));
      case 'boilerspace-discover-syllabus':
        return reply(pageWork('discover-syllabus', message));
      case 'boilerspace-read-quiz':
        return reply(pageWork('read-quiz', message));
      case 'boilerspace-toggle':
        toggleDrawer();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  setTimeout(async () => {
    const token = await xsrfToken(null);
    loadLib('page-sync.js')
      .then((sync) => sync.autoSyncIfDue({ xsrfToken: token }))
      .catch(() => {});
  }, AUTO_SYNC_DELAY_MS);

  // ---------- Panel ----------

  const pushStyle = document.createElement('style');
  pushStyle.textContent = `
    html.boilerspace-pushed { margin-right: var(--boilerspace-width, ${DEFAULT_WIDTH}px) !important; }
    html.boilerspace-animating { transition: margin-right 180ms ease !important; }
    @media (prefers-reduced-motion: reduce) { html.boilerspace-animating { transition: none !important; } }
  `;
  (document.head ?? document.documentElement).append(pushStyle);

  const root = document.createElement('div');
  root.id = 'boilerspace-root';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .drawer {
        position: fixed; top: 0; right: 0; z-index: 2147483000;
        width: var(--boilerspace-width, ${DEFAULT_WIDTH}px); max-width: 100vw; height: 100vh;
        background: #fff;
        transform: translateX(100%);
        transition: transform 180ms ease;
      }
      .drawer.open { transform: none; border-left: 1px solid #d3d9e3; }
      .drawer:not(.open) { pointer-events: none; border-left: 0; }
      .drawer:not(.open) .collapse { pointer-events: auto; }
      .drawer.overlay { box-shadow: -12px 0 32px rgba(0, 0, 0, 0.16); }
      .drawer.resizing { transition: none; }
      .drawer.resizing iframe { pointer-events: none; }
      iframe { display: block; width: 100%; height: 100%; border: 0; }
      .handle {
        position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; z-index: 1;
      }
      .handle:hover, .drawer.resizing .handle { background: linear-gradient(to right, transparent 3px, #006fbf 3px, #006fbf 5px, transparent 5px); }
      .collapse {
        position: absolute; top: 14px; left: -32px; z-index: 2;
        width: 32px; height: 36px; padding: 0; cursor: pointer;
        display: grid; place-items: center;
        border: 1px solid #d3d9e3; border-right: 0; border-radius: 6px 0 0 6px;
        background: #fff; color: #202122;
        box-shadow: -4px 0 12px rgba(32, 33, 34, 0.08);
      }
      .collapse svg { transform: rotate(180deg); }
      .drawer.open .collapse svg { transform: none; }
      .collapse:hover { color: #006fbf; }
      @media (prefers-color-scheme: dark) {
        .drawer, .collapse { background: #141417; color: #f2f2f5; }
        .drawer.open, .collapse { border-color: #37373f; }
        .collapse:hover { color: #75b5ff; }
      }
      @media (prefers-reduced-motion: reduce) { .drawer, .drawer.open { transition: none; } }
    </style>
    <div class="drawer" role="complementary" aria-label="BoilerSpace">
      <button class="collapse" type="button" title="Open BoilerSpace" aria-label="Open BoilerSpace">
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M7.5 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="handle" title="Drag to resize"></div>
    </div>
  `;
  const drawer = shadow.querySelector('.drawer');
  const handle = shadow.querySelector('.handle');
  const collapse = shadow.querySelector('.collapse');
  document.documentElement.append(root);

  let iframe = null;
  let navButton = null;
  let width = DEFAULT_WIDTH;
  const isOpen = () => drawer.classList.contains('open');

  function layout({ animate = false } = {}) {
    const html = document.documentElement;
    const push = isOpen() && window.innerWidth - width >= MIN_PAGE_WIDTH;
    html.style.setProperty('--boilerspace-width', `${width}px`);
    root.style.setProperty('--boilerspace-width', `${width}px`);
    html.classList.toggle('boilerspace-animating', animate);
    html.classList.toggle('boilerspace-pushed', push);
    drawer.classList.toggle('overlay', isOpen() && !push);
    if (animate) setTimeout(() => html.classList.remove('boilerspace-animating'), 220);
  }

  function setOpen(open, { remember = true } = {}) {
    if (open && !iframe) {
      iframe = document.createElement('iframe');
      iframe.src = extensionUrl('sidepanel.html?embedded=1');
      iframe.title = 'BoilerSpace';
      drawer.append(iframe);
    }
    drawer.classList.toggle('open', open);
    collapse.title = open ? 'Collapse BoilerSpace' : 'Open BoilerSpace';
    collapse.setAttribute('aria-label', collapse.title);
    navButton?.setAttribute('aria-expanded', String(open));
    layout({ animate: true });
    if (open) iframe.focus();
    if (remember) chrome.storage.local.set({ drawerOpen: open }).catch(() => {});
  }

  const toggleDrawer = () => setOpen(!isOpen());
  collapse.addEventListener('click', toggleDrawer);
  window.addEventListener('resize', () => layout());

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    drawer.classList.add('resizing');
    const move = (e) => {
      width = Math.round(Math.min(Math.max(window.innerWidth - e.clientX, MIN_WIDTH), Math.min(MAX_WIDTH, window.innerWidth)));
      layout();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      drawer.classList.remove('resizing');
      chrome.storage.local.set({ drawerWidth: width }).catch(() => {});
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });

  // Messages from the panel are JSON strings, which cross between the page and the extension frame cleanly in both browsers.
  const toPanel = (payload) => iframe?.contentWindow?.postMessage(JSON.stringify(payload), extensionOrigin);

  window.addEventListener('message', (event) => {
    if (event.origin !== extensionOrigin || typeof event.data !== 'string') return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data?.type === 'boilerspace-close') setOpen(false);
    if (data?.type === 'boilerspace-navigate') {
      try {
        const url = new URL(data.url);
        if (url.origin === location.origin && url.pathname.startsWith('/d2l/')) location.assign(url.href);
      } catch {
        /* not a URL */
      }
    }
    if (data?.type === 'boilerspace-request') {
      pageWork(data.action, data.args)
        .then((response) => toPanel({ type: 'boilerspace-response', id: data.id, ...response }))
        .catch((err) => toPanel({ type: 'boilerspace-response', id: data.id, ok: false, error: err.message }));
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) setOpen(false);
  });

  chrome.storage.local.get(['drawerOpen', 'drawerWidth']).then(({ drawerOpen, drawerWidth }) => {
    if (drawerWidth) width = drawerWidth;
    layout();
    if (drawerOpen) setOpen(true, { remember: false });
  });

  // ---------- Navbar button ----------

  function navbarSlot() {
    return (
      document.querySelector('.d2l-navigation-s-header-right') ??
      document.querySelector('d2l-navigation-main-header [slot="right"]') ??
      document.querySelector('d2l-navigation-main-header .d2l-navigation-header-right')
    );
  }

  function makeNavButton() {
    const host = document.createElement('div');
    host.className = 'boilerspace-nav-item';
    host.style.cssText = 'display:inline-flex;align-items:center;height:100%;margin:0 4px;';
    const navShadow = host.attachShadow({ mode: 'open' });
    navShadow.innerHTML = `
      <style>
        button {
          all: unset; box-sizing: border-box; cursor: pointer;
          display: inline-flex; align-items: center; gap: 8px;
          height: 40px; padding: 0 10px 0 8px; border-radius: 6px;
          font: 400 15px/1 Lato, "Lucida Sans Unicode", "Lucida Grande", sans-serif; color: #202122;
        }
        button:hover, button[aria-expanded="true"] { color: #006fbf; }
        button:focus-visible { box-shadow: 0 0 0 2px #006fbf; }
        img { width: 22px; height: 22px; border-radius: 5px; }
      </style>
      <button type="button" title="BoilerSpace" aria-expanded="false"><img alt="" src="${extensionUrl('icons/icon48.png')}"><span>BoilerSpace</span></button>
    `;
    const button = navShadow.querySelector('button');
    button.addEventListener('click', toggleDrawer);
    navButton = button;
    return host;
  }

  function placeNavButton() {
    const slot = navbarSlot();
    if (!slot) return false;
    if (!slot.querySelector(':scope > .boilerspace-nav-item')) slot.prepend(makeNavButton());
    navButton.setAttribute('aria-expanded', String(isOpen()));
    return true;
  }

  if (!placeNavButton()) {
    const observer = new MutationObserver(() => placeNavButton() && observer.disconnect());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), NAV_WAIT_MS);
  }
})();
