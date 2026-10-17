// Starts a persistent test browser that separate local tools can attach to over CDP.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const profile = path.join(root, '.verify-tmp/live-profile');
const port = Number(process.env.BOILERSPACE_CDP_PORT ?? 9223);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BOILERSPACE_CDP_PORT must be an integer from 1024 to 65535.');
const endpoint = `http://127.0.0.1:${port}`;
const log = path.join(root, '.verify-tmp/live-browser.log');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const listening = await new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const finish = (connected) => { socket.destroy(); resolve(connected); };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(1000, () => finish(false));
});

let child;
if (!listening) {
  mkdirSync(profile, { recursive: true });
  const fd = openSync(log, 'a', 0o600);
  try {
    child = spawn(chromium.executablePath(), [
      `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      '--enable-automation',
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-extensions-except=${path.join(root, 'extension')}`,
      `--load-extension=${path.join(root, 'extension')}`,
      'https://purdue.brightspace.com/d2l/home',
    ], { detached: true, stdio: ['ignore', fd, fd] });
    await once(child, 'spawn');
    child.unref();
  } finally {
    closeSync(fd);
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    ready = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    if (ready) break;
    await pause(250);
  }
  if (!ready) throw new Error(`The test browser did not start. Close any other browser using .verify-tmp/live-profile; keep its profile and lock files intact. See ${log}`);
}

const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
try {
  const session = await browser.newBrowserCDPSession();
  const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
  await session.detach();
  if (!args.includes(`--user-data-dir=${profile}`)) throw new Error(`Port ${port} belongs to a different browser profile. Choose another BOILERSPACE_CDP_PORT.`);
  const pid = child?.pid ?? null;
  writeFileSync(path.join(root, '.verify-tmp/live-browser.json'), JSON.stringify({ endpoint, profile, pid }, null, 2), { mode: 0o600 });
  console.log(`BoilerSpace test browser ${listening ? 'already running' : 'ready'}: ${endpoint}`);
  console.log('Attach with chromium.connectOverCDP(endpoint) and use browser.contexts()[0].');
  console.log('Closing this CDP client leaves the shared browser running.');
} finally {
  await browser.close();
}
