# Contributing to BoilerSpace

Bug reports, fixes, and focused improvements are welcome. For a larger change, open an issue first so its scope and browser behavior can be discussed.

## Local setup

The extension runs directly from `extension/`. There is no bundler or production dependency install. Load that directory using the [README instructions](README.md#install), reload the extension after edits, and refresh Brightspace.

Development checks use Node.js 22 or newer. The browser checks below use Playwright 1.58.2, the version used for the current live verification. Playwright is a development tool, not part of the extension.

### Unit tests

Some Brightspace API tests use the public MIT-licensed fixtures from [Brightspace Bar](https://github.com/DavidChen-006/Brightspace-Bar). Keep that checkout inside the ignored test directory:

```sh
mkdir -p .verify-tmp
git clone https://github.com/DavidChen-006/Brightspace-Bar.git .verify-tmp/Brightspace-Bar
git -C .verify-tmp/Brightspace-Bar checkout 78290ad6d6a7a30ce381042bbd1572c41fdf15ef
BOILERSPACE_FIXTURES_DIR=.verify-tmp/Brightspace-Bar/session-capture/tests/fixtures npm test
```

`BOILERSPACE_FIXTURES_DIR` accepts a relative or absolute directory. Without it, the current test harness falls back to the original sibling checkout at `../open-source-workbench/repos/Brightspace-Bar/session-capture/tests/fixtures/`.

The unit suite does not need Purdue credentials or make live model requests.

### Isolated browser checks

Install the pinned development dependencies and Chromium:

```sh
npm ci --ignore-scripts
npx playwright install chromium
export BOILERSPACE_FIXTURES_DIR=.verify-tmp/Brightspace-Bar/session-capture/tests/fixtures
node scripts/verify.mjs ./node_modules/playwright/index.mjs
node scripts/verify-syllabi.mjs ./node_modules/playwright/index.mjs
```

These scripts use throwaway Chromium profiles. The broader interface check runs headlessly by default; set `VERIFY_HEADED=1` to open a visible window. The syllabus check always opens a visible window. Brightspace and GenAI Studio requests are intercepted with fixtures. They do not use your real course session. `verify.mjs` checks the wider interface; `verify-syllabi.mjs` checks delayed syllabus rendering, missing sections, permissions, retries, fresh downloads, and concurrent readers.

Use `VERIFY_OUT=/tmp/boilerspace-verification` to choose a screenshot directory. The broader script otherwise writes to `verification/`; the focused script defaults to a temporary directory. Review screenshots before committing them, since existing demonstration assets are tracked.

### Continuous integration

[CI](https://github.com/ltmerletti/BoilerSpace/actions/workflows/ci.yml) runs on pushes and pull requests, and can also be started manually from GitHub Actions. It runs the unit suite on Node.js 22 and 24, plus both isolated Chromium suites in separate jobs. The wider interface suite runs headlessly at standard pixel density; the syllabus suite uses visible Chromium under `xvfb-run`. Both exercise real pointer input into the embedded extension panel. The broader suite also saves a Playwright trace and captures page state if it throws.

CI installs from `package-lock.json` and checks out the public fixtures at the same pinned commit shown above. It needs no Purdue credentials, API keys, or repository secrets. Each browser job uploads any generated fixture-test screenshots for seven days, including on failure. New runs cancel older runs on the same branch or pull request.

These checks cover fixture behavior in Chromium. They do not replace signed-in verification of Purdue authentication, actual course pages, or Firefox/Zen behavior.

### Live verification

For a change involving authentication, cross-origin frames, or a course's actual rendering behavior, use the real-site test as well:

```sh
PLAYWRIGHT_PATH=./node_modules/playwright/index.mjs node scripts/verify-live-syllabi.mjs --fresh
```

Sign into Brightspace in the test browser and use BoilerSpace's **Connect** button for GenAI Studio if needed. Complete account sign-in yourself. The normal connection flow reuses your GenAI Studio API key, or creates one if the account has none.

The script keeps its browser profile in `.verify-tmp/live-profile/`, which is ignored by Git. `--fresh` clears only the syllabus caches in that test profile. It preserves sign-ins and the course snapshot. The script compares automatic and manual scans, verifies reload and CS 250's Read again control when enrolled, and asks the CS 251 AI-policy question when enrolled. These are real requests to Purdue GenAI Studio.

Close an existing test browser using that profile before starting another run. Live screenshots go to `/tmp/boilerspace-live-verification/` and can contain real course information; do not commit them without checking and redacting them.

### Benchmarks

`node bench/run.mjs --check` validates a local capture and cases without network requests. It requires `bench/data/capture.json` and `bench/data/cases.json`, which are deliberately not distributed. It is not a fresh-clone test command. See [bench/README.md](bench/README.md) for the capture format and live benchmark commands.

## Changes and validation

Keep changes focused and use the existing plain JavaScript and CSS structure. Explain the user-visible problem and how the change fixes it. Preserve source attribution, third-party licenses, the quiz-attempt guard, and the separation between course sync and syllabus work.

Run checks appropriate to the change. For browser-sensitive work, report which browser and which path you actually tested: a fixture test, a real signed-in test, or both. Chrome-only automation is not independent Firefox verification. Never describe unrun checks as passing.

Use synthetic data for new fixtures. Do not add credentials, cookies, signed download URLs, browser profiles, grade records, or private course captures to a pull request. For screenshots, the real interface can be captured after renaming visible course and personal names in the HTML; explain any edits in the documentation.

## Reports and pull requests

For bugs, include the browser/version, extension commit or version, reproduction steps, expected behavior, and the exact error with private details removed. A course with no syllabus and a failed syllabus read are different cases.

Pull requests should state what changed and the checks performed, including any checks that could not be run. Contributions to BoilerSpace's original code are submitted under the repository's GPLv3 license. No separate contributor agreement is required.

Follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), rather than posting sensitive details in a public issue.
