// One-off check: does the panel iframe inside a Brightspace page see the same extension storage in Firefox?
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const profile = fs.mkdtempSync(path.join(process.env.VERIFY_TMP ?? os.tmpdir(), 'zen-'));
const HOME = '<!doctype html><html><head><title>Home</title></head><body><d2l-navigation><d2l-navigation-main-header><div slot="right" class="d2l-navigation-s-header-right"><span>Me</span></div></d2l-navigation-main-header></d2l-navigation><main>hi</main></body></html>';

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX_PATH ?? '/Applications/Zen.app/Contents/MacOS/zen',
  userDataDir: profile,
  headless: true, args: ['--no-remote', '--new-instance'], timeout: 45000,
});
try {
  const id = await browser.installExtension(path.join(root, 'extension'));
  console.log('installed', id);
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().startsWith('https://purdue.brightspace.com/')) {
      if (req.url().includes('/d2l/api/') || req.url().includes('/d2l/lp/auth')) return req.respond({ status: 503, body: '' });
      return req.respond({ status: 200, contentType: 'text/html', body: HOME });
    }
    return req.continue();
  });
  await page.goto('https://purdue.brightspace.com/d2l/home');
  await page.waitForFunction(() => document.querySelector('.boilerspace-nav-item'), { timeout: 15000 });
  const extUrl = await page.evaluate(() => document.querySelector('.boilerspace-nav-item').shadowRoot.querySelector('img').src);
  const base = extUrl.replace(/icons\/.*$/, '');
  console.log('extension base', base);

  const top = await browser.newPage();
  await top.goto(base + 'sidepanel.html');
  console.log('top-level set', await top.evaluate(async () => {
    await chrome.storage.local.set({ probe: 'from top-level page' });
    return (await chrome.storage.local.get('probe')).probe;
  }));

  await page.bringToFront();
  await page.evaluate(() => document.querySelector('.boilerspace-nav-item').shadowRoot.querySelector('button').click());
  let frame = null;
  for (let i = 0; i < 50 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('sidepanel.html'));
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('iframe url', frame?.url());
  if (frame) {
    console.log('iframe reads', await frame.evaluate(async () => JSON.stringify(await chrome.storage.local.get('probe'))));
    await frame.evaluate(() => chrome.storage.local.set({ probe2: 'from iframe' }));
    console.log('top-level reads iframe write', await top.evaluate(async () => JSON.stringify(await chrome.storage.local.get('probe2'))));
  }
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
