# Privacy and data handling

BoilerSpace is a browser extension that works through your existing Purdue sessions. It does not operate a separate BoilerSpace account service or backend.

## Stored on your device

The extension uses `chrome.storage.local` / the compatible Firefox extension storage for:

- Synced course information, assignments, quizzes, announcements, calendar items, content listings, course overview text, and grade records returned by sync.
- Readable syllabus text, extracted dates and policies, chosen syllabus sources, and saved date preferences.
- Conversations, answers, citations, settings, and sync status.
- Your GenAI Studio connection information and API key, plus any custom API base URL, model ID and API key you save. Only the selected provider is used for model requests.
- If you connect Ed or Piazza, Ed/Piazza course links, post text, replies, author roles, direct post URLs, and discussion sync status. Author profile names and account identifiers are omitted; names written in post text may remain.

This data is not placed in the browser's extension sync storage. Copies in other browser profiles or devices are separate. Treat an authenticated browser profile and its extension storage as sensitive.

BoilerSpace does not run in private browsing. The Firefox package uses Firefox's built-in installation consent for authentication information, personal communications and website content. Those categories cover the service sign-ins, questions, discussion excerpts and course content described below; they do not authorize analytics or advertising.

## Requests to Purdue services

| Service | What BoilerSpace uses it for |
| --- | --- |
| Purdue Brightspace | Course sync and course-file access through your signed-in session |
| Purdue Simple Syllabus | The syllabus document launched by Brightspace, including its embedded frames |
| Purdue GenAI Studio | Account connection, model selection, syllabus extraction, and answers |

Syllabus extraction sends readable syllabus text and course context to your selected model provider. Answering questions sends your question, relevant conversation context, course context, and material returned by the assistant's tools. This can include document excerpts, announcements, assignment or quiz descriptions, and readable questions from a finished or closed quiz. When requested for a supported model, a document page or slide image can also be included.

Grade records and quiz scores are excluded from the assistant's model inputs. BoilerSpace does not add its own analytics, advertising, or crash-reporting service. Opening the original Purdue pages still loads those services normally; their own privacy and retention policies apply. This project does not control GenAI Studio's server-side retention or model-provider policies.

## Optional OpenAI-compatible API

Settings lets you choose Purdue GenAI Studio or an OpenAI-compatible API. The custom option stores an API base URL, model ID and API key in local extension storage. Keys are not synced, included in data or benchmark exports, or inserted into conversations. A local server on localhost or 127.0.0.1 can be used without a key. The extension does not provide a separate encrypted credential vault.

Saving the custom connection selects it for Ask, conversation titles and automatic syllabus extraction. These requests send the same questions, conversation context, relevant course content, discussion excerpts and supported document images described above to the API you choose. Existing conversation text can be sent to that provider when you continue a chat. Your API key is sent as a Bearer credential to the configured API endpoint. Browser cookies are omitted, redirects are refused, and requests set `store: false`. That flag does not determine every provider's logging or retention practices. The provider's charges, privacy policy and retention rules apply. BoilerSpace does not proxy these requests through Purdue or a project server.

The manifest declares optional access to HTTPS sites so you can enter an API host. **Save and use** requests permission for the entered host only. HTTP is allowed only for localhost and 127.0.0.1. Browser host permissions cover that host across paths and ports. Granting this optional permission does not add content scripts or run code from the API site. HTTPS is required for other hosts.

The Purdue and custom connections are saved separately. Selecting another provider changes the destination for subsequent model requests. Removing the custom connection deletes its saved URL, model and key without switching to Purdue automatically. Clearing local data removes both saved connections. These actions do not revoke keys at the provider, delete its server records, or remove browser-granted site access. You can revoke that access in your browser's extension settings.

## Optional Ed and Piazza

Ed and Piazza access is requested only when you choose to connect them. Refreshes make direct requests from the extension without opening site tabs. Connecting Ed reads its authentication token from an existing signed-in Ed page and keeps it in local extension storage so the connection survives browser restarts. BoilerSpace renews that credential through Ed's own renewal endpoint while in use. An already-open signed-in Ed page can supply a replacement when needed; recovery does not create or navigate tabs. The token is removed after an unrecoverable authentication failure, when Ed access is revoked, when its final course is disconnected, or when local data is cleared. It is not included in exports, conversations or model requests. BoilerSpace does not ask for discussion passwords.

Piazza requests use its existing browser sign-in cookies. The extension fetches a page as text to obtain a CSRF token without executing that page's scripts, then reads course metadata through Piazza's API. Account profiles returned during discovery are discarded. Automatic Brightspace matching uses course codes, terms and title similarity locally, without sending course names to a model. An expired session shows **Reconnect**; automatic refresh does not open a sign-in page.

Discussion retrieval uses a bundled POTION token table and BM25 in a local browser worker. Embedding posts and searching them makes no external requests. The worker keeps its search vectors in memory, rebuilds them when saved posts change, and releases them after a minute idle or when the panel page unloads. It does not create a separate persistent vector database or query log. Selected passages still go to your selected model provider when Ask uses them to answer your question, as described above.

The reader reads the full available history per connected course, with available replies. Imports run in batches and save progress locally so interrupted imports can resume. Later syncs check history pages and reopen new or changed posts. It omits posts and replies explicitly marked private or deleted. Instructor/student roles are retained so answers can distinguish staff guidance from student suggestions. Attachments and images are not read. Refreshing uses the same read endpoints as the sites, which may update their normal read/view tracking; BoilerSpace does not create posts, reply, vote, or enroll in courses.

Discussion text stays in extension storage until used by Ask or exported. Questions about connected discussions can send matching excerpts and saved replies to your selected model provider, with direct thread citations. Disconnecting a discussion source removes its cached posts and course link. Existing chats and exports may still contain quoted discussion content. **Clear local data** clears the discussion cache along with the rest of extension storage.

## Optional Gradescope

Gradescope access is requested when you choose to connect. The reader uses your existing browser cookies to fetch the account's course list and current-term student assignment lists. These HTML responses can contain score columns; the parser removes submission-status and score elements, then extracts only course names, course links, assignment headings, canonical assignment links, and published release, due and late due timestamps. It does not inspect score values, open submissions, read grading feedback, or save raw pages. No Gradescope password, cookie or authentication token is copied into extension storage.

The saved assignment metadata appears in Week, course details, calendar and data exports, and Ask tools. Relevant metadata can go to your selected model provider when you ask a question. Missing dates are not inferred, and late deadlines do not replace normal deadlines. OCR and assignment document reading are not included. Refreshes run directly without opening site tabs. Choosing Connect or Reconnect can open a visible sign-in page. Disconnecting Gradescope or clearing local data removes its cached courses and assignments; existing chats and exports can retain cited metadata.

## Sign-in and API keys

You sign into Purdue in the browser. BoilerSpace does not ask you to enter your Purdue password into its settings. It uses the existing Brightspace session to read course material and the GenAI Studio connection flow to obtain an API key.

The normal GenAI Studio connection reuses an existing key, or creates one if the account has none. Disconnecting removes the saved connection from this browser. It does not revoke the key at GenAI Studio; revoke it there if needed.

## Exports and screenshots

**Download data (JSON)** omits both saved model connections and the Ed authentication credential. It can still contain course data, grades from the local snapshot, syllabus text, connected discussion posts, and conversations. It is not an anonymized export.

**Save benchmark data** omits grade records and the student's profile record and scrubs email addresses and phone numbers. It includes course material and previous questions, so it is not guaranteed anonymous. Instructor names, course identifiers, and other identifying text may remain.

Calendar exports contain event titles, dates, and links. Screenshots can reveal personal names, course enrollments, document text, or conversation history. Review exports and images before sharing them.

Browser test profiles and benchmark captures are ignored by Git. The README images were captured from the running extension after renaming course names, course identifiers, and the greeting in the page HTML; that did not change stored course data.

## Standalone companion

The optional `mcp/` companion runs separately from the browser extension. It opens a dedicated Chromium profile for Purdue sign-in, verifies that session, and stores Purdue cookies and an XSRF token in its own local data directory. The dedicated profile can also retain Purdue SSO state. The companion does not collect your password. After sign-in it uses direct HTTPS requests to Purdue Brightspace, without a background browser. A short-lived Brightspace API bearer can be minted in memory; it is not saved in the session file or returned through tools.

Its default directory is `~/.local/share/boilerspace-companion`, or `$XDG_DATA_HOME/boilerspace-companion` when set. `BOILERSPACE_DATA_DIR` and `--data-dir` can choose another location. The directory contains credentials, the dedicated browser profile, and a SQLite index of current course metadata, downloaded document text, page hashes, local semantic vectors and job progress. Raw downloaded documents are not retained by the index. Unix directories and session/index files use owner-only permissions. They are not encrypted. Windows users must protect the directory through their account's access controls.

The companion reads course content, posted assignment and quiz instructions, announcements and calendar metadata. Grade endpoints, submissions, quiz attempts and answer keys are outside its request allowlist. Account data used to verify sign-in is discarded rather than indexed. Course documents can themselves contain names or other personal information. The companion does not connect the extension's Ed, Piazza, Gradescope or model accounts.

The companion has no model-provider connection and sends no course text to a project server. MCP tools return requested evidence to the client you connect, such as a local agent application. That client may send it to its own model provider under the client's settings and policy. Cached search and page reads work locally without contacting Purdue. Sync and document indexing contact Purdue, and its normal access logging can apply.

`logout` removes the saved companion session and dedicated browser profile but retains indexed material. To delete the index and all companion credentials, stop its processes and remove its data directory. Extension clearing controls do not affect the companion, and companion logout does not sign you out of your personal browser. Keep this directory, test profiles and live reports out of version control and shared folders.

## Delete local data

Use **Settings → Advanced → Clear local data** to clear BoilerSpace's extension storage in the current browser profile. This also removes its saved model connections and API keys. Exported files, test profiles, and data already sent to Purdue or another model provider are not removed by that control. Clearing extension storage does not sign you out of Purdue websites.

For a suspected leak, credential exposure, or unauthorized cross-course access, follow [SECURITY.md](SECURITY.md). For general questions, open a [GitHub issue](https://github.com/ltmerletti/BoilerSpace/issues) with private information removed.
