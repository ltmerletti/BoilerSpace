# Using BoilerSpace

[Back to the README](../README.md)

## Open the panel

Sign into Purdue Brightspace, then click **BoilerSpace** in the course navigation bar. The arrow at the edge of the panel opens or closes it. You can also use the extension's browser toolbar button. Chrome opens a side panel; Firefox and Zen open a sidebar.

BoilerSpace supports desktop Chrome 124+ and Firefox 140+, including compatible Zen releases. Use a current browser version. Private browsing and other universities' Brightspace installations are not supported.

## Connect your accounts

### Purdue GenAI Studio

Open **Settings** and choose **Connect** beside Purdue GenAI Studio. Complete any Purdue sign-in prompts. BoilerSpace uses your own account to answer questions and read syllabi. You can change the model inside the expanded connection row.

The thinking control in Ask appears for recognized models. **Default** leaves the provider's reasoning settings unchanged. Other available levels depend on the selected model. Higher thinking levels can take longer to answer.

### Ed and Piazza

Choose **Connect** beside Ed or Piazza in **Settings**, then approve the site's access request. Existing sign-ins are reused. If you need to sign in, connection resumes afterward.

The panel embedded in Brightspace may open a short permission handoff in an extension tab. The browser sidebar connects directly. Keep BoilerSpace open while its initial history import runs.

Ed discovers active US courses. Piazza finds visible classes from your signed-in page; **Add a class by link** is available if the class is not found automatically.

Discussion courses are matched to Brightspace by course code and distinctive title. Older terms and ambiguous matches stay separate. To change a match, expand the connection, open the class's **Options**, and choose its **Brightspace course**. Manual choices are preserved on later syncs. A class without a Brightspace match can still be searched in Ask.

### Gradescope

Choose **Connect** beside Gradescope in **Settings** and allow site access. Your existing Gradescope sign-in is reused. If it has expired, connection opens a visible sign-in page and continues after you sign in.

BoilerSpace imports current-term assignment names, links, release dates, due dates and late deadlines. Recognizable course codes match Brightspace automatically. Assignments with dates appear in Week and calendar exports; the course page and Settings also list assignments with no published date. Ask can find this metadata and cite Gradescope, including courses without a Brightspace match.

Under each course's **Options**, you can change its Brightspace link. For an unmatched course, leave **All my courses** selected in Ask and name the Gradescope course in your question.

Normal and late deadlines remain separate. Missing dates stay unknown. Scores, submitted answers, grading feedback and assignment question text are not read. OCR is not included.

Gradescope refreshes at most every 20 minutes while BoilerSpace is open. Use **Sync assignments now** for an immediate update. Routine updates do not open site tabs. Temporary failures keep saved assignments; an expired sign-in or revoked permission shows the shared reconnect reminder. **Disconnect Gradescope** removes its saved course and assignment data.

## Ask a course question

Choose a course, or leave **All my courses** selected. Name the lecture, file, project, or topic when it helps identify what you mean. Follow-up questions stay in the same conversation.

Ask can search syllabi, course files, announcements, connected discussion history, and saved Gradescope assignment names and dates. It can also read questions from finished or closed quizzes when Brightspace makes them available. It excludes quiz scores and stays off active quiz attempt pages.

Course files can be PDF, modern Word or PowerPoint files, RTF, HTML, Markdown, source code, CSV/TSV, JSON and other common text formats. Compatible Office templates, slideshows and macro-enabled variants use the same text readers; macros never run. When a lecture has several copies in the same folder, Ask prefers the PDF.

Jupyter notebooks (`.ipynb`, version 4) provide Markdown, code and raw cell text, cited by original cell number. Saved outputs and attachments are skipped. Source and text files preserve indentation and use line-range citations. These citations link back to the Brightspace item. RTF citations use parts, with embedded objects and pictures skipped.

During a lookup, the work log opens to show narration and tool calls in order. It collapses when answer text starts and reopens if the model returns to research. You can open or close it while text is streaming. Expand a tool's **Details** to inspect its arguments and a short result preview. You can scroll back, stop generation, copy an answer, or retry it.

Citations open the original material. Overview PDFs may open in BoilerSpace's document reader at the cited page. **Show original PDF** loads the source through your signed-in session.

## Sync and syllabus checks

Course sync and syllabus reading run separately. Assignments and announcements can finish syncing while a slower syllabus page is still loading. Routine background updates keep the existing view visible. Use the header's refresh button for a manual sync.

After course sync, BoilerSpace checks syllabi for current courses. It can read Content files, course overview attachments, and the **Syllabus** navigation tab, including JavaScript-rendered Simple Syllabus documents.

If you see **Allow Simple Syllabus access**, use that control and approve access on the extension's permission page. Granting permission starts a retry automatically.

Temporary network or loading failures get one retry after the other courses finish. A completed search that finds no syllabus is remembered for a day. Use **Courses → Check again** for a new pass, or the course's **Check again** / **Read again** control for one course. If the automatic choice is wrong, choose another course file or upload the syllabus.

Clear syllabus dates are added to the agenda and calendar automatically. If syllabus dates conflict with Brightspace, the agenda uses Brightspace and keeps the discrepancy available to inspect.

## Theme

Choose **Light**, **Dark**, or **System** under **Settings → Theme**. System is the default and follows your system appearance as it changes. Your choice is saved for this browser profile and applies across all panel tabs and other open BoilerSpace panels.

## Discussion history and sync

Discussion imports save progress in batches and resume after interruption. Settings shows the saved post count and whether the history check is complete. Later syncs check history pages and reread new or changed posts. Discussions refresh independently at most every 20 minutes while BoilerSpace is open, or through **Sync discussions now**.

Discussion refreshes make requests directly from the extension. They do not open, navigate or close site tabs. If your sign-in cannot be renewed or restored, saved posts stay available and Settings shows **Reconnect**. Temporary update failures offer **Retry** and recover automatically on a later refresh. Only choosing **Connect** or **Reconnect** can open a visible sign-in page.

A small reminder below the panel's sync controls, visible on every tab, appears when Ed, Piazza or Gradescope needs reconnection. Its buttons start reconnection directly. The reminder clears when access is restored and stays hidden for temporary update failures.

Connections survive browser restarts and extension reloads. Ed renews its saved credential silently while you use BoilerSpace; an already-open signed-in Ed page can also repair the connection without navigation. Piazza reuses its existing browser sign-in cookies. Reconnect is needed when the site no longer accepts the saved sign-in and automatic recovery cannot restore it.

Course previews show up to three posts from the past seven days. Ask searches the full saved history, including older posts and available replies. Private and deleted posts are excluded. Discussion attachments and images must be opened on the original site.

## Update the extension

Download the latest source or pull the repository changes. Reload the existing extension entry in `chrome://extensions` or `about:debugging`, then refresh Brightspace. Refreshing the website alone does not load updated extension scripts.

Firefox and Zen temporary add-ons are removed when the browser quits. Load `extension/manifest.json` again for the next session.

## Export or remove local data

Calendar export is in **Settings**. Data exports and **Clear local data** are under **Advanced**. Exports can include course material and conversations. They are not anonymized. See [Privacy](../PRIVACY.md) for storage and deletion details.

## If something is not working

- **A connection needs attention.** Expand its Settings row and reconnect. Check that the site is signed in and that requested access was approved.
- **A syllabus check failed.** Resolve any Simple Syllabus permission request first, then retry the course. A course without a syllabus is different from a failed check.
- **An import stopped.** Keep BoilerSpace open and run **Sync discussions now**. Saved batches are retained.
- **A Gradescope assignment has no date.** Gradescope does not publish dates for every assignment. It remains in the assignment list but stays out of Week and calendar exports until a date is available. Late deadlines are shown separately.
- **Gradescope dates look stale.** Expand Gradescope in Settings and choose **Sync assignments now**. An expired sign-in offers Reconnect; a temporary service failure offers Retry and keeps the previous list.
- **An answer is missing a source.** Confirm the relevant course or discussion history has synced. Name the file or thread if the question could refer to several things.
- **The interface did not change after an update.** Reload the extension itself, then refresh Brightspace.

For other problems, [open an issue](https://github.com/ltmerletti/BoilerSpace/issues) with your browser, the steps to reproduce, and any visible error. Remove private course information from screenshots and logs. Report vulnerabilities through [Security](../SECURITY.md).
