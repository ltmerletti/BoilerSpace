# Share the signed-in test browser

Codex, Antigravity, and other local Playwright tools can attach to one running Chromium instance. It uses the existing `.verify-tmp/live-profile` so saved sign-ins and BoilerSpace data stay in that test profile.

From the repository root, after `npm ci --ignore-scripts` and `npx playwright install chromium`:

```sh
npm run browser:live
```

The launcher opens a visible browser with the extension loaded and CDP at **http://127.0.0.1:9223**. Running it again reuses that browser after checking its profile. Close the browser window when finished. The launcher process can exit while the browser remains open.

The endpoint is restricted to this machine. Port 9223 avoids the common 9222 endpoint used by other browser tools. Set `BOILERSPACE_CDP_PORT` to choose another port; the selected endpoint is also written to the ignored `.verify-tmp/live-browser.json` file.

## Attach from Antigravity or another local script

Run Playwright from this repository, or use its absolute package path from another directory:

```js
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const context = browser.contexts()[0];
const home = context.pages().find(page =>
  page.url().startsWith('https://purdue.brightspace.com/d2l/')
);

console.log(await home.title());
// Inspect and interact with the existing pages here.

await browser.close(); // Disconnect this CDP client; the shared browser stays open.
```

Use the existing context to access its saved sign-ins and extension storage. `browser.newContext()` creates an isolated context. Avoid `context.close()` or the CDP `Browser.close` command, which close the shared session. Coordinate clicks between tools so only one drives the interface at a time.

For an Antigravity handoff:

> Attach to the running BoilerSpace browser with Playwright's `chromium.connectOverCDP('http://127.0.0.1:9223')`. Use `browser.contexts()[0]` and the existing Brightspace and extension pages. The repository's Playwright package is in `node_modules/playwright`. Disconnect with `browser.close()` when finished; leave the shared browser and its persistent context open.

## Profile locks

Only one Chromium process can open a profile directory. If an older Playwright runner already has `.verify-tmp/live-profile` open through its private pipe, close that runner's browser normally first, then start this launcher. Keep the profile and its lock files intact; a live lock is not a stale-file problem.

Once the shared browser is running, other tools should attach over CDP instead of calling `launchPersistentContext` with the same profile. The standalone `verify-live-syllabi.mjs` command still owns its browser, so close the shared browser before using that command.

CDP gives local clients control of this signed-in test browser. Keep the endpoint on loopback and keep the profile, browser logs, screenshots, and endpoint metadata out of version control. Live tests can make real requests to Purdue GenAI Studio.
