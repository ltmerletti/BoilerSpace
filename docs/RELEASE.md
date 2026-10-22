# Preparing a release

Firefox Add-ons is the first public install destination. Chrome is supported through an unpacked package. Store approval and a signed Firefox download are separate from passing the checks below.

## Reproduce the packages

Use Node.js 22 or 24, npm, and a clean checkout of the release commit. No Purdue account, local captures, model download or environment variables are needed to build.

```sh
npm ci --ignore-scripts
npm run build
npm run lint:firefox
```

The build copies the original extension code without minification or bundling. It removes Chrome-only manifest fields and its background worker from the Firefox package, and Firefox-only fields and its background script from the Chrome package. All third-party runtime files are copied byte for byte. ZIP entries use fixed timestamps and sorted paths, so repeating the build produces identical archives.

Output in `dist/`:

- `boilerspace-1.0.0-firefox.zip`: unsigned package for Mozilla submission, with `manifest.json` at its root.
- `boilerspace-1.0.0-chrome.zip`: extract and load its folder at `chrome://extensions` using **Load unpacked**.
- `boilerspace-1.0.0-sources.zip`: original extension code, packaging scripts, dependency lockfile, licenses and these build instructions for reviewers. It can be extracted and built without a Git checkout.
- `checksums.json`: SHA-256 for each package and every packaged file.
- `firefox-lint.json`: complete Mozilla validator report.

The build only accepts runtime asset paths in `extension/` and adds the root license and third-party notices. It rejects symlinks and unexpected runtime files. It does not include browser profiles, saved posts, questions, benchmark captures, API keys, screenshots, test reports, `.git`, `node_modules` or development experiments.

## Firefox permissions and compatibility

The Firefox package requires desktop Firefox 140 or newer, including compatible Zen releases. This supports Firefox's native data-consent prompt. The required data categories cover credentials sent to their original services, questions and discussion excerpts sent to the selected model provider, and course/site content used by the assistant. There is no telemetry. The Chrome package requires Chrome 124 or newer. Private browsing is disabled because the extension retains course material and conversation history locally.

Brightspace, Simple Syllabus and GenAI Studio are required hosts. Ed, Piazza and Gradescope are optional and requested only on connection. Custom model APIs use optional HTTPS host access, plus HTTP for localhost and 127.0.0.1. The setup form requests only the entered host. No remote code is loaded. The same Firefox data categories cover user-selected model providers. Routine discussion and Gradescope refreshes make direct requests; they do not open site tabs. Syllabus discovery still uses temporary rendered Brightspace/Simple Syllabus tabs, which it closes after reading.

## Notes for Mozilla reviewers

This is a Purdue-specific extension. Production verification needs an authorized Purdue account with Brightspace and GenAI Studio access; Ed, Piazza and Gradescope are optional. Never supply a student's account, password, API key or saved course data in public review notes. Arrange an institution-approved review account or agree on a review method with Mozilla before submission. Synthetic automated checks are useful evidence but do not replace reviewer access to authenticated functionality.

Start in Brightspace and choose **BoilerSpace** in its navigation bar, or use the browser toolbar sidebar. Connect GenAI Studio in Settings, let courses and syllabi sync, and ask about course material. Optional connections are in the same view. An expired session retains cached material and offers Reconnect in the shared panel header. Scores are excluded from Ask; the Gradescope reader only keeps assignment names, links and published dates. See `PRIVACY.md` for the complete data flow.

The validator's remaining reviewed warnings are restricted to:

- Manifest Android compatibility: this release deliberately has no `gecko_android` key and is available only on desktop. The linter nevertheless compares the desktop minimum of 140 against Android's data-consent minimum of 142. Do not enable Android in the listing.
- `content.js`: two static HTML templates with extension-owned constants/URLs, and a dynamic import resolving only hard-coded local module names.
- LinkeDOM's unmodified upstream parser: `innerHTML` is used to parse inert fetched HTML, not to insert it into the displayed page. Gradescope scripts, score elements and submission status are removed before metadata extraction.
- PDF.js's unmodified upstream release: internal dynamic imports and `Function` detection. All three document-reading/rendering entry points explicitly set `isEvalSupported: false`; extension CSP excludes `unsafe-eval` and remote scripts. The worker, character maps, fonts, JPEG2000 decoder and color-conversion assets are bundled locally, including the decoder's upstream JavaScript fallback.

First-party source is readable. Bundled library versions, source links and license notices are in `THIRD_PARTY_NOTICES.md`, with additional pinned hashes in the LinkeDOM and retrieval-model provenance files. The model is a local numeric token table, not executable remote code.

## Submission gate

- [x] Local unit, integration, streaming, recovery and packaged-install checks pass; CI repeats the release gate on every push and pull request.
- [x] Build is reproducible; Mozilla validator has no errors or unreviewed warnings.
- [x] Fresh install, upgrade from the previous main (0.2.0) and retained local data are checked in desktop Firefox.
- [x] Prior signed-in Chrome and Zen integration checks are recorded privately without scores or credentials. The new packaged Firefox check uses synthetic traffic and a synthetic model, not Purdue authentication.
- [ ] Approved reviewer access or review instructions are arranged.
- [x] Listing copy, privacy URL, approved screenshots and release notes are prepared.
- [ ] Mozilla approves/signs the package; verify the signed install and update the README with the actual Add-ons URL before advertising that install link.

### Validation on October 18, 2026

| Check | Result |
| --- | --- |
| Unit suite | 243 passing, including cross-time-zone byte-identical package rebuilds and upstream library hashes |
| Built Chrome package | 84 interface, 35 streaming, 16 syllabus, 30 discussion, 23 recovery and 18 Gradescope checks passing |
| Official Firefox 158 | 16 packaged-install checks passing; 17 with the additional previous-main upgrade check |
| Mozilla add-on validator 10.14.0 | Zero errors; 11 reviewed warnings described above |
| npm dependency audit | Zero reported vulnerabilities |

The Firefox test runs the original package without adding scripts or changing its permissions. Browser automation's temporary-install mechanism bypasses the native install/consent prompt. Its model responses and network responses are synthetic. Earlier private signed-in checks established real course imports and model citations in Chrome and Zen; they are not a substitute for a signed Firefox installation check.

To repeat an upgrade check, build the previous published release separately and set `VERIFY_UPGRADE_FROM=/absolute/path/to/previous-firefox.zip` when running `scripts/verify-release-firefox.mjs`. The check creates its own profile, seeds synthetic local records, installs the new archive with the same extension ID, and verifies retention before running the fresh-data checks. Do not point it at a personal profile.

## Listing draft

**Name:** BoilerSpace

**Summary:** Your Purdue courses, upcoming work and course questions, together in Brightspace.

**Description:** BoilerSpace adds a compact panel beside your Purdue Brightspace courses. Keep assignments and upcoming dates in view, ask questions about lecture slides and syllabi, and follow citations back to the material behind an answer. Connect Ed and Piazza to search saved public discussions and instructor replies. Connect Gradescope to include assignments and published deadlines.

Uses your existing sign-ins. Course answers and syllabus extraction use Purdue GenAI Studio or an OpenAI-compatible API you configure. Relevant questions, course material and discussion excerpts are sent to the selected provider; saved course data and conversations stay in this browser. Optional services can be disconnected in Settings. Gradescope scores, submissions and feedback are not read.

**Privacy URL:** https://github.com/ltmerletti/BoilerSpace/blob/main/PRIVACY.md

**Support URL:** https://github.com/ltmerletti/BoilerSpace/issues

**License:** GPL-3.0-only

Use the approved real interface screenshots in `docs/images/`. Do not use local test captures or account details as listing assets.
