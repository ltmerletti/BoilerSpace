# Changelog

What changed, what prompted it, and what it means when you use BoilerSpace. Each entry links to the implementation. Dates use Purdue's West Lafayette time.

[Back to the README](README.md) · [Full commit history](https://github.com/ltmerletti/BoilerSpace/commits/main)

## October 17, 2026

This round focused on the interruptions that make an otherwise useful tool frustrating: controls that miss clicks, narration that disappears, imports that stop, and updates that draw attention away from studying.

- **Keep reconnection within reach.** A compact reminder below the sync controls names Ed or Piazza when its sign-in needs attention. Reconnect from the reminder without finding the connection in Settings; it clears as soon as access is restored. Temporary update failures leave it hidden.

- **Sync discussions without opening tabs.** Ed and Piazza refresh directly from the extension. A sign-in that cannot be restored keeps saved posts available and offers Reconnect in Settings. A sign-in page opens only after choosing Connect or Reconnect. Connections survive browser restarts and extension reloads. Ed renews its saved credential silently and can recover from an already-open signed-in page; Piazza uses the browser's existing sign-in cookies. Temporary renewal failures keep a working credential, and a post-level access denial does not disconnect the Ed account.

- **Keep interrupted imports moving.** Coming back online retries affected discussion sources without restarting healthy ones. Piazza's overlapping pinned posts no longer stop an otherwise progressing history import.

- **Keep research inside the work log.** Intermediate narration used to appear below a closed log, making it look like part of the answer. Research now starts expanded, stays in one ordered log, and collapses when answer text starts. Manual toggles survive streaming and rerenders; if the model returns to tools, the research log reopens.

- **A clearer introduction to BoilerSpace.** The README starts with a question about a specific radiation slide, followed by a review outline built from lecture material and instructor guidance collected from Ed. The examples ask questions a student could bring to the course without already knowing which file or post contains the answer. Detailed setup instructions have their own guide, and screenshots show actual model answers. [Details](https://github.com/ltmerletti/BoilerSpace/pull/3)

- **Open details while an answer is arriving.** Streaming tokens were replacing the element under the pointer before a click finished. The panel now updates it in place. Narration stays visible during lookups, then moves into the work log when the answer starts. The thinking control is lighter, and routine refreshes keep the cached view quiet. [Details](https://github.com/ltmerletti/BoilerSpace/commit/af6f892)

- **Reuse the Piazza tab you already have.** A trailing slash in a class URL could make an open tab look like a different destination. Matching now accepts that URL, avoiding an unnecessary temporary reader tab. [Details](https://github.com/ltmerletti/BoilerSpace/commit/cce5004)

- **Take public-text discussion retrieval out of beta.** The final checks covered real imports, source citations and both browser engines. The frozen answer check returned 34 correct core answers and six intended clarification or abstention responses. The notes retain the remaining grounding limits; attachments and images still require the original site. [Details](https://github.com/ltmerletti/BoilerSpace/commit/3ac4ba1)

- **Wait through a busy Purdue API without getting stuck.** Purdue sometimes reports a rate limit as a regular request error. BoilerSpace recognizes that response, respects the retry delay and lets Stop cancel the wait. Other request errors still surface normally. [Details](https://github.com/ltmerletti/BoilerSpace/commit/f485a4a)

- **Use the new orbit icon consistently.** Toolbar and panel assets now use the supplied design, including the small sizes seen most often in a browser. [Details](https://github.com/ltmerletti/BoilerSpace/commit/ad88560)

- **Make the conversation easier to follow.** Preserve the order of narration and tools, add readable result previews, generate shorter chat titles and simplify conversation history. A model-aware thinking control leaves the existing reasoning behavior unchanged on Default. [Details](https://github.com/ltmerletti/BoilerSpace/commit/c1b912c)

- **Read the rest of a completed quiz review.** Ask can read available questions from finished reviews, including longer reviews spread across pages. Scores are excluded, and active attempts remain off limits. [Details](https://github.com/ltmerletti/BoilerSpace/commit/4646b9e)

- **Resume discussion imports in Firefox.** Fix background startup and message handling so the reader can wake reliably and continue short import batches after an interruption. Previously saved progress is retained. [Details](https://github.com/ltmerletti/BoilerSpace/commit/2905ebf)

- **Keep the launcher available when Brightspace changes its header.** Support the current navigation component as well as the older layout, so the BoilerSpace button appears in either. [Details](https://github.com/ltmerletti/BoilerSpace/commit/40ee3ab)

- **Give course details and connections less visual weight.** Reduce the course hover highlight, make back navigation directional and keep the AI policy inside Syllabus. Connection titles open the original site; course linking and disconnect sit under Options. Recent discussion previews use posting dates, so an old post does not look new just because it was reread. [Details](https://github.com/ltmerletti/BoilerSpace/commit/349ef14)

<details>
<summary>Verification added in this round</summary>

- **Test what happens between the happy paths.** Add browser restart and offline-import recovery checks, incremental streaming tests and Firefox worker coverage to CI. Document the live checks separately from synthetic tests, including the limits of each. [Details](https://github.com/ltmerletti/BoilerSpace/commit/19f04b5)

</details>

These changes landed in [PR #2](https://github.com/ltmerletti/BoilerSpace/pull/2), preserving the individual commits. [Merge](https://github.com/ltmerletti/BoilerSpace/commit/e033578)

## October 16, 2026

Ed and Piazza became searchable alongside course material. Setup and the panel layout were then revised around the way students actually move between reading, asking and checking a source.

- **Keep the conversation in view.** Adopt the selected compact Brightspace design, tighten the layout and keep the composer visible while messages scroll. Work logs and sources are expandable, with live activity, stop, copy and retry controls close to the answer. [Details](https://github.com/ltmerletti/BoilerSpace/commit/58a97bf)

- **Show the real interface in the documentation.** Update setup instructions and replace older documentation images with captures of the running panel. Course labels are renamed for privacy. [Details](https://github.com/ltmerletti/BoilerSpace/commit/3c06414)

- **Ask for fewer routine setup decisions.** Discover discussion classes, match clear course codes and titles, and continue connecting after sign-in. Keep drafts, focus and open controls during background updates. Clear syllabus dates can enter the agenda automatically, with conflicts available to inspect. [Details](https://github.com/ltmerletti/BoilerSpace/commit/bab74ab)

- **Find discussion answers even when the wording differs.** Combine exact-term and semantic search locally, without a separate search account or server. Load the search model when needed and release it after inactivity, with keyword search available if model loading fails. [Details](https://github.com/ltmerletti/BoilerSpace/commit/cfa78b8)

- **Bring Ed and Piazza into Ask.** Add the first discussion beta with paginated imports, available replies, source links and course selection. Imports save progress between batches so a large class history is not limited to the first page. [Details](https://github.com/ltmerletti/BoilerSpace/commit/66a85ca)

<details>
<summary>Research and live-test support</summary>

- **Make search comparisons reproducible.** Add frozen discussion cases, evidence checks and browser measurements so search changes can be compared on the same questions. Publish aggregate results while keeping private course captures out of the repository. [Details](https://github.com/ltmerletti/BoilerSpace/commit/998ed20)

- **Check more recent model candidates.** Extend the small-model comparison and record relevant public benchmark results. Accuracy, latency and memory all remain part of the decision. [Details](https://github.com/ltmerletti/BoilerSpace/commit/930fb59)

- **Measure semantic search against the existing search.** Add a local embedding comparison with the existing keyword search as a baseline. Use the same questions to check whether a model improves retrieval. [Details](https://github.com/ltmerletti/BoilerSpace/commit/f6aad72)

- **Keep live verification signed in.** Add a dedicated persistent test browser that separate local tools can attach to. This lets real setup and reading flows be checked without repeatedly rebuilding the test session. [Details](https://github.com/ltmerletti/BoilerSpace/commit/cdf5d5e)

</details>

The discussion work landed in [PR #1](https://github.com/ltmerletti/BoilerSpace/pull/1). [Merge](https://github.com/ltmerletti/BoilerSpace/commit/0e6b5fc)

## October 15, 2026

Syllabus reading needed to handle the page a student actually sees, including slow rendering and sign-in permissions. Several fixes addressed different parts of that path instead of treating every failure as a missing syllabus.

- **Use the rendered syllabus for both automatic checks and retries.** Refresh expired document links, wait for browser-rendered content and retry temporary failures after the other courses finish. A missing syllabus and a failed read keep distinct states. The Simple Syllabus permission flow can resume the check after access is granted. [Details](https://github.com/ltmerletti/BoilerSpace/commit/42b2bc0)

- **Try the next syllabus source when a file is missing.** A broken candidate no longer ends the search for the course. Recover navigation sources and exercise the automatic retry path in browser checks. [Details](https://github.com/ltmerletti/BoilerSpace/commit/137aa7b)

- **Keep the agenda usable after a failed reread.** Skip unusable syllabus records and build dates from the retained successful record when one is available. [Details](https://github.com/ltmerletti/BoilerSpace/commit/9a0437c)

- **Do not invent a time for a syllabus date.** A deadline only gets a clock time when the supporting quote actually contains it. Apply the same check to already-saved dates, so an earlier unsupported time does not persist. [Details](https://github.com/ltmerletti/BoilerSpace/commit/9441ce3)

- **Open the evidence behind an answer.** Read complete document pages and add a reader that opens citations at the relevant page, with access to the original PDF. [Details](https://github.com/ltmerletti/BoilerSpace/commit/bcc15ca)

- **Give slow syllabus pages time to render.** Wait for document content to arrive and distinguish a loading failure from a completed search that found nothing. [Details](https://github.com/ltmerletti/BoilerSpace/commit/da1f956)

- **Let course sync finish independently.** Move syllabus discovery out of the main course sync, so a slow syllabus does not hold assignments and announcements behind it. Keep the sync ownership alive while its work is still running. [Details](https://github.com/ltmerletti/BoilerSpace/commit/ef1d7c1)

- **Retry an answer even when it completed.** Retry is available on the latest answer, not just errors and stopped responses. There is no need to type the same question again. [Details](https://github.com/ltmerletti/BoilerSpace/commit/1d33bee)

- **Look beyond a file named "syllabus."** Discover syllabi through course navigation tabs and shared templates as well as ordinary course files. [Details](https://github.com/ltmerletti/BoilerSpace/commit/ade4aae)

- **Remove the floating launcher.** Use the panel's edge arrow to open or collapse it, leaving the bottom corner of Brightspace clear. [Details](https://github.com/ltmerletti/BoilerSpace/commit/4071451)

- **Recover a stopped conversation.** Add panel collapse controls and let a stopped answer be retried or continued. [Details](https://github.com/ltmerletti/BoilerSpace/commit/dd9145f)

- **Read larger lecture decks and quiz questions.** Add text reading for large slide files and question access for quizzes without passing scores to the assistant. [Details](https://github.com/ltmerletti/BoilerSpace/commit/d69d8dd)

<details>
<summary>Storage, testing and project documentation</summary>

- **Protect results when more than one panel is open.** Coordinate syllabus saves through the background context so one panel cannot overwrite another course's result during a concurrent save. [Details](https://github.com/ltmerletti/BoilerSpace/commit/d5f46cb)

- **Run regression checks on pushes and pull requests.** Add CI for units and isolated browser tests, giving later changes a repeatable check outside the developer's signed-in browser. [Details](https://github.com/ltmerletti/BoilerSpace/commit/bfee295)

- **Make the project easier to install and contribute to.** Add GPLv3 licensing, privacy and security documentation, contribution guidance and real interface screenshots. Bundled dependencies retain their own notices. [Details](https://github.com/ltmerletti/BoilerSpace/commit/d91165f)

- **Let verification run from another checkout.** Make local fixture and browser paths configurable instead of depending on one machine's directory layout. [Details](https://github.com/ltmerletti/BoilerSpace/commit/22244c8)

</details>

## October 14, 2026

- **Find exams that were not labeled as exams.** Treat titles such as midterm and checkpoint as assessments, and check announcements before presenting an upcoming-exam list as complete. For review questions, look for the lecture's stated learning objectives before answering. [Details](https://github.com/ltmerletti/BoilerSpace/commit/614c0d3)

- **Explain how to get started.** Add the first README covering installation, everyday use and local test commands. [Details](https://github.com/ltmerletti/BoilerSpace/commit/c0077e8)

## October 13, 2026

- **Give Ask a way to read more precisely.** Return smaller, ranked passages with a page outline and a way to open a specific page. This helps the assistant follow a promising result into the document instead of repeatedly searching the same file. [Details](https://github.com/ltmerletti/BoilerSpace/commit/f2b644e)

- **Search the material that has actually been opened.** Include opened course files and quiz details in search, find items by title and report when a file failed to open. An unreadable source must not be presented as evidence. [Details](https://github.com/ltmerletti/BoilerSpace/commit/e32c663)

- **Record the starting point.** The first tracked snapshot includes the course panel, planner, syllabus reader, calendar export and Purdue GenAI Studio assistant. This is the beginning of the recorded development history. [Details](https://github.com/ltmerletti/BoilerSpace/commit/ff8bf07)

<details>
<summary>Early answer-quality checks</summary>

- **Make answer changes measurable.** Add a benchmark runner and scorer that check answers, source citations and expected missing-information behavior against saved cases. [Details](https://github.com/ltmerletti/BoilerSpace/commit/52304d1)

- **Capture evidence for repeatable tests.** Add local course-data capture so an evaluation can revisit the same material. Private captures remain outside Git. [Details](https://github.com/ltmerletti/BoilerSpace/commit/35b7f8e)

</details>
