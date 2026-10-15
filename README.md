# BoilerSpace

BoilerSpace is a browser extension that sits beside Purdue Brightspace. It syncs your current courses, shows what is due, and answers questions from syllabi, announcements, assignments, quizzes, and course files. Answers cite the page or item they came from.

It runs in Chrome and in Firefox, including Zen. Questions go to your own Purdue GenAI Studio account. Course data stays in the browser. Grades are never sent to the model.

## Install

You need to be signed in to [Purdue Brightspace](https://purdue.brightspace.com) and to [Purdue GenAI Studio](https://genai.rcac.purdue.edu).

**Chrome.** Open `chrome://extensions`, turn on Developer mode, and choose Load unpacked. Select the `extension` folder in this repo.

**Firefox and Zen.** Open `about:debugging#/runtime/this-firefox` and choose Load Temporary Add-on. Select `extension/manifest.json`. Firefox drops temporary add-ons when the browser quits, so load it again next session.

Then open Brightspace and click BoilerSpace in the navigation bar, or the arrow tab near the top-right edge of the page. The arrow opens and collapses the panel. The browser toolbar button also opens BoilerSpace: a side panel in Chrome, or a sidebar in Firefox and Zen. Connect GenAI Studio from the panel. Sign in with your Purdue account when it opens. The default model is `qwen3.8:27b`. Change it in Settings.

After you pull new code, reload the extension. Chrome caches the old scripts until you do.

## Using it

The Week tab is the agenda. Dates come from Brightspace and from syllabi the extension has read. A syllabus date that Brightspace does not list yet is marked that way.

Course sync saves assignments, quizzes, announcements, and calendar dates separately from syllabus discovery and reading. A slow syllabus page does not hold up that sync. After course sync, BoilerSpace checks syllabi for every current course automatically. Some courses do not post a syllabus; a missing overview attachment triggers a search of the remaining sources. Missing results are remembered for a day. Courses offers Check all syllabi, and each course has a retry control even when discovery failed before finding a file. Read again downloads the file afresh. The header distinguishes course-sync completion from syllabus work.

The Ask tab answers from your synced courses. It can open PDF, PowerPoint (`.pptx`), Word (`.docx`), and HTML files in Brightspace. It cannot read old `.ppt` files, `.rtf`, scanned PDFs, video, or links that leave Brightspace. It does not run on quiz attempt pages.

Citations point to the page used in the answer. A PDF attached to the course overview opens in BoilerSpace's document reader at the cited page, with the complete saved text. Show original PDF opens the original through your signed-in Brightspace session. Dates from a syllabus only get an exact time when the supporting quote states it; regular class hours are not treated as a posted exam start time.

Settings can export an `.ics` file of Brightspace due dates plus syllabus dates you confirmed. Import that file into Google Calendar or Outlook. Settings can also save a benchmark capture of the synced courses.

## Develop

```bash
npm test
node bench/run.mjs --check
```

`npm test` runs the unit tests. `node bench/run.mjs --check` checks the benchmark cases against a local capture and makes no network calls. Live benchmark runs and the capture format are documented in [bench/README.md](bench/README.md).

`scripts/open-chrome.sh` opens Chrome for Testing with the extension loaded and a profile in `.chrome-profile/`. That profile is gitignored. `scripts/verify.mjs` loads the extension in a throwaway browser and checks the panel against fake course data. `scripts/verify-syllabi.mjs` separately checks the automatic pass for all current courses, a missing overview attachment, a navbar link rendered after ten seconds, retry controls, and consecutive fresh downloads. Both browser scripts need Playwright, which this repo does not install itself.
