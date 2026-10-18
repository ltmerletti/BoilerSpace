# Privacy and data handling

BoilerSpace is a browser extension that works through your existing Purdue sessions. It does not operate a separate BoilerSpace account service or backend.

## Stored on your device

The extension uses `chrome.storage.local` / the compatible Firefox extension storage for:

- Synced course information, assignments, quizzes, announcements, calendar items, content listings, course overview text, and grade records returned by sync.
- Readable syllabus text, extracted dates and policies, chosen syllabus sources, and saved date preferences.
- Conversations, answers, citations, settings, and sync status.
- Your GenAI Studio connection information and API key.
- If you connect Ed or Piazza, Ed/Piazza course links, post text, replies, author roles, direct post URLs, and discussion sync status. Author profile names and account identifiers are omitted; names written in post text may remain.

This data is not placed in the browser's extension sync storage. Copies in other browser profiles or devices are separate. Treat an authenticated browser profile and its extension storage as sensitive.

## Requests to Purdue services

| Service | What BoilerSpace uses it for |
| --- | --- |
| Purdue Brightspace | Course sync and course-file access through your signed-in session |
| Purdue Simple Syllabus | The syllabus document launched by Brightspace, including its embedded frames |
| Purdue GenAI Studio | Account connection, model selection, syllabus extraction, and answers |

Syllabus extraction sends readable syllabus text and course context to the selected GenAI Studio model. Answering questions sends your question, relevant conversation context, course context, and material returned by the assistant's tools. This can include document excerpts, announcements, assignment or quiz descriptions, and readable questions from a finished or closed quiz. When requested for a supported model, a document page or slide image can also be included.

Grade records and quiz scores are excluded from the assistant's model inputs. BoilerSpace does not add its own analytics, advertising, or crash-reporting service. Opening the original Purdue pages still loads those services normally; their own privacy and retention policies apply. This project does not control GenAI Studio's server-side retention or model-provider policies.

## Optional Ed and Piazza

Ed and Piazza access is requested only when you choose to connect them. Refreshes make direct requests from the extension without opening site tabs. Connecting Ed reads its authentication token from an existing signed-in Ed page and keeps it in local extension storage so the connection survives browser restarts. BoilerSpace renews that credential through Ed's own renewal endpoint while in use. An already-open signed-in Ed page can supply a replacement when needed; recovery does not create or navigate tabs. The token is removed after an unrecoverable authentication failure, when Ed access is revoked, when its final course is disconnected, or when local data is cleared. It is not included in exports, conversations or model requests. BoilerSpace does not ask for discussion passwords.

Piazza requests use its existing browser sign-in cookies. The extension fetches a page as text to obtain a CSRF token without executing that page's scripts, then reads course metadata through Piazza's API. Account profiles returned during discovery are discarded. Automatic Brightspace matching uses course codes, terms and title similarity locally, without sending course names to a model. An expired session shows **Reconnect**; automatic refresh does not open a sign-in page.

Discussion retrieval uses a bundled POTION token table and BM25 in a local browser worker. Embedding posts and searching them makes no external requests. The worker keeps its search vectors in memory, rebuilds them when saved posts change, and releases them after a minute idle or when the panel page unloads. It does not create a separate persistent vector database or query log. Selected passages still go to Purdue GenAI Studio when Ask uses them to answer your question, as described above.

The reader reads the full available history per connected course, with available replies. Imports run in batches and save progress locally so interrupted imports can resume. Later syncs check history pages and reopen new or changed posts. It omits posts and replies explicitly marked private or deleted. Instructor/student roles are retained so answers can distinguish staff guidance from student suggestions. Attachments and images are not read. Refreshing uses the same read endpoints as the sites, which may update their normal read/view tracking; BoilerSpace does not create posts, reply, vote, or enroll in courses.

Discussion text stays in extension storage until used by Ask or exported. Questions about connected discussions can send matching excerpts and saved replies to Purdue GenAI Studio, with direct thread citations. Disconnecting a discussion source removes its cached posts and course link. Existing chats and exports may still contain quoted discussion content. **Clear local data** clears the discussion cache along with the rest of extension storage.

## Sign-in and API keys

You sign into Purdue in the browser. BoilerSpace does not ask you to enter your Purdue password into its settings. It uses the existing Brightspace session to read course material and the GenAI Studio connection flow to obtain an API key.

The normal GenAI Studio connection reuses an existing key, or creates one if the account has none. Disconnecting removes the saved connection from this browser. It does not revoke the key at GenAI Studio; revoke it there if needed.

## Exports and screenshots

**Download data (JSON)** omits the saved GenAI Studio connection and Ed authentication credential. It can still contain course data, grades from the local snapshot, syllabus text, connected discussion posts, and conversations. It is not an anonymized export.

**Save benchmark data** omits grade records and the student's profile record and scrubs email addresses and phone numbers. It includes course material and previous questions, so it is not guaranteed anonymous. Instructor names, course identifiers, and other identifying text may remain.

Calendar exports contain event titles, dates, and links. Screenshots can reveal personal names, course enrollments, document text, or conversation history. Review exports and images before sharing them.

Browser test profiles and benchmark captures are ignored by Git. The README images were captured from the running extension after renaming course names, course identifiers, and the greeting in the page HTML; that did not change stored course data.

## Delete local data

Use **Settings → Advanced → Clear local data** to clear BoilerSpace's extension storage in the current browser profile. This also removes its saved GenAI Studio connection. Exported files, test profiles, and data already sent to Purdue services are not removed by that control. Clearing extension storage does not sign you out of Purdue websites.

For a suspected leak, credential exposure, or unauthorized cross-course access, follow [SECURITY.md](SECURITY.md). For general questions, open a [GitHub issue](https://github.com/ltmerletti/BoilerSpace/issues) with private information removed.
