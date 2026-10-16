<img src="extension/icons/icon128.png" width="64" height="64" alt="BoilerSpace icon">

# BoilerSpace

[![CI](https://github.com/ltmerletti/BoilerSpace/actions/workflows/ci.yml/badge.svg)](https://github.com/ltmerletti/BoilerSpace/actions/workflows/ci.yml)

Your Purdue Brightspace courses, deadlines, syllabi, and course questions in one side panel.

BoilerSpace is a browser extension for Chrome, Firefox, and Zen. It reads your current courses from Brightspace, finds syllabi, and answers questions with citations through your own Purdue GenAI Studio account. There is no separate BoilerSpace account or server.

<p align="center">
  <img src="docs/images/week.png" width="270" alt="Week view showing upcoming work and syllabus dates to confirm">
  <img src="docs/images/courses.png" width="270" alt="Courses view showing automatic syllabus checks and AI policy summaries">
  <img src="docs/images/ask.png" width="270" alt="Ask view researching a midterm across the syllabus and lecture material, with citations">
</p>

*Screenshots are from the running extension with real course data. Course names, course identifiers, and the greeting were renamed in the page HTML for privacy.*

## What it does

- **Week:** upcoming assignments, quizzes, and exams, plus dates found in syllabi. Confirm syllabus-only dates before adding them to your calendar export.
- **Courses:** current enrollments, upcoming work, syllabus text, and cited policy summaries. Syllabi are checked automatically, including Purdue Simple Syllabus pages.
- **Ask:** questions about your course material, with citations to the source page or item. Conversations can be revisited and answers retried.
- **Settings:** choose a GenAI Studio model, export an `.ics` calendar, download local data, or disconnect and clear the extension's data.

Course sync and syllabus reading run separately. Assignments and announcements can finish syncing while a slow syllabus page is still loading. Some courses have no syllabus; a confirmed missing syllabus is shown separately from a failed check.

## Ed and Piazza beta

In **Settings → Discussions (beta)**, choose **Connect Ed courses** or enter a Piazza class URL and choose **Connect Piazza class**. Approve the optional site access in the extension tab. Sign into the discussion site in the same browser profile if prompted, then retry.

Ed discovers active US courses and matches unambiguous course codes to current Brightspace courses. Piazza classes and unmatched courses can stay separate, or you can choose their Brightspace course in Settings. That keeps an older class from being mixed into a current course's answers.

The beta imports **the full available discussion history**, including available replies, in batches. It saves progress after each batch and resumes interrupted imports on the next sync. Later syncs check every history page and only reopen new or changed posts. Settings shows the saved post count and whether the history check is complete. Ask can search those saved posts, open a saved thread, distinguish staff replies from student suggestions, and cite the original Ed/Piazza link. Linked courses also show recent post links on their course page. Discussion sync has its own status and **Sync discussions now** control; it refreshes independently at most every 20 minutes while BoilerSpace is open.

The beta does not read attachments, post, reply, or vote. It excludes private and deleted posts. Site changes can interrupt the reader; a failed refresh keeps the last successful posts and shows an error. Relevant discussion text may be sent to Purdue GenAI Studio when you ask. See [Privacy](PRIVACY.md#optional-ed-and-piazza-beta).

## Ask across your course material

> Hey can you tell me what the Course C syllabus says about the midterm, what it covers, and what I should review in the course materials?

Ask can search your course material, open relevant files, read syllabus pages and lecture slides, and bring the findings into one answer. The expandable work log shows its actual lookups, and citations let you check each finding against the source.

The example above comes from a real midterm question. BoilerSpace opened the syllabus and the relevant lecture material before answering. The course name is shown as **Course C** in the screenshots.

<details>
  <summary>See part of the actual lecture-material lookup</summary>
  <p><img src="docs/images/ask-research.png" width="540" alt="Expanded work log showing the actual lecture decks opened for the midterm question, with course identifiers renamed"></p>
</details>

## Install

This is a source installation. The extension has no build step, and Node.js is not needed to use it.

1. [Download the source ZIP](https://github.com/ltmerletti/BoilerSpace/archive/refs/heads/main.zip) and extract it, or clone the repository:

   ```sh
   git clone https://github.com/ltmerletti/BoilerSpace.git
   cd BoilerSpace
   ```

2. Load the `extension` folder using your browser's instructions below.
3. Sign into [Purdue Brightspace](https://purdue.brightspace.com), open BoilerSpace, and use **Connect** to link [Purdue GenAI Studio](https://genai.rcac.purdue.edu). Complete any Purdue sign-in prompts in the browser.
4. Allow the requested access to Brightspace, GenAI Studio, and Purdue Simple Syllabus.

### Chrome

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension` folder. Keep that folder in place after installation.

### Firefox and Zen

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extension/manifest.json`. Temporary add-ons are removed when the browser quits; load it again next session.

### Open and update BoilerSpace

On Brightspace, click **BoilerSpace** in the navigation bar or use the arrow at the edge of its panel. The browser toolbar button also opens it: a side panel in Chrome, or a sidebar in Firefox and Zen.

After updating the source, reload the existing extension entry in `chrome://extensions` or `about:debugging`, then refresh Brightspace. Refreshing the website alone does not load updated extension scripts.

## Browser support

The manifest targets Chrome 116+ and Firefox 128+, including compatible Zen versions. Use a current browser release.

| Browser | Verification |
| --- | --- |
| Chrome / Chromium | Automated UI checks and signed-in live tests |
| Zen | Confirmed in a signed-in user session |
| Standard Firefox | Compatibility reviewed; no separate automated live Firefox suite yet |

BoilerSpace is currently specific to Purdue's Brightspace, Simple Syllabus, and GenAI Studio domains. Other universities' Brightspace installations are not configured.

## Syllabi and citations

After course sync, BoilerSpace checks syllabi for every current course. It can read files in Content, course overview attachments, and the **Syllabus** navigation tab, including its JavaScript-rendered Simple Syllabus document.

If you see **Allow Simple Syllabus access**, click it to open the extension's permission page, then approve access there. Granting permission starts a retry automatically. A site-permission problem cannot be fixed by repeatedly checking individual courses.

Temporary network or loading failures get one retry after the other courses finish. A completed search that finds no syllabus is remembered for a day. Use **Check all syllabi** for a fresh pass, or the course's **Check again** / **Read again** control to retry one course. If the automatic choice is wrong, select another course file or upload the syllabus.

Answers cite the material they used. Overview PDFs open in BoilerSpace's document reader at the cited page, and **Show original PDF** opens the source through your signed-in session. Check important dates and policies against the cited material.

## Data and permissions

Course data, conversations, settings, and the GenAI Studio API key are stored locally in the browser's extension storage. Syllabus text is sent to Purdue GenAI Studio to extract dates and policies. Questions, relevant course material, and conversation context are sent there to answer questions. Grade records are excluded from model requests.

| Site access | Purpose |
| --- | --- |
| `purdue.brightspace.com` | Sync courses and read course material through your signed-in session |
| `purdue.simplesyllabus.com` | Read the rendered syllabus launched by Brightspace |
| `genai.rcac.purdue.edu` | Connect your account and request model responses |

BoilerSpace does not add its own analytics or send data to a separate BoilerSpace server. Exports can contain course content and conversation history. See [Privacy](PRIVACY.md) for storage, exports, and deletion details.

## Current limits

- Supported document formats include PDF, `.pptx`, `.docx`, and HTML. Scanned PDFs without readable text, old `.ppt` files, `.rtf`, video, and arbitrary external websites are not supported.
- The extension stays off quiz attempt pages. The assistant's quiz reader excludes scores and uses finished attempts or closed quizzes.
- The default model is `qwen3.8:27b`; availability and response speed depend on Purdue GenAI Studio. Change the model in Settings.
- This is an independent project, not an official Purdue or D2L product.

## Development and feedback

See [Contributing](CONTRIBUTING.md) for test setup, local browser checks, and signed-in live verification. The benchmark suite has its own [guide](bench/README.md); its private captures and cases are not included in a clone.

Report reproducible bugs or suggest changes through [GitHub Issues](https://github.com/ltmerletti/BoilerSpace/issues). Follow the [security reporting instructions](SECURITY.md) for vulnerabilities, and remove personal course information from screenshots and logs. Project participation follows the [code of conduct](CODE_OF_CONDUCT.md).

## License and credits

Copyright (C) 2026 Luke Merletti. BoilerSpace's original code is licensed under the **GNU General Public License, version 3 only** (`GPL-3.0-only`). See [LICENSE](LICENSE). The extension directory also includes [COPYING](extension/COPYING) and [NOTICE](extension/NOTICE) so its license travels with the installable files.

Bundled libraries and fonts retain their own licenses. See [Third-party notices](THIRD_PARTY_NOTICES.md). The project license does not grant rights to instructors' course documents, third-party services, or their trademarks.
