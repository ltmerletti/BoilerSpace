# BoilerSpace companion

Give a local agent access to your Purdue Brightspace courses, with document search, page citations and a persistent index. Sign in once in a separate browser. The companion then reads Brightspace directly, without installing the extension or keeping a browser open.

MCP and the CLI use the same tools. The companion does not need a GenAI Studio key, call a language model, or run a public server.

## Set up

Use Node.js 22.13 or later. Clone the **full BoilerSpace repository** and keep it in place. This package shares document readers and bundled search assets with the extension's source code.

From the repository root:

```sh
npm ci --prefix mcp
cd mcp
npx --no-install playwright install chromium
node cli.mjs login
node cli.mjs call refresh_courses --wait
```

Sign into Purdue in the new window. It closes after the companion verifies the connection. You can pass `--browser /absolute/path/to/chrome` to use an installed Chromium browser for this separate profile.

On Linux, Playwright may also need system libraries. Use its [browser installation instructions](https://playwright.dev/docs/browsers#install-system-dependencies).

### Connect an MCP client

For Codex, register the local command with an **absolute path**:

```sh
codex mcp add boilerspace -- node /absolute/path/to/BoilerSpace/mcp/cli.mjs serve
```

The equivalent configuration for an MCP client that launches stdio servers is:

```json
{
  "mcpServers": {
    "boilerspace": {
      "command": "node",
      "args": ["/absolute/path/to/BoilerSpace/mcp/cli.mjs", "serve"]
    }
  }
}
```

Client configuration formats differ. The important settings are the command, arguments and stdio transport. Codex setup follows its [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Each client must run on a machine that can access the repository and the saved companion data. This command does not expose your local index to a remote web client.

## Use it

Ask your agent something that requires reading the material:

> Find the posted scope for my first exam. Go through the lectures it covers and build a topic outline with the learning objectives. Tell me which documents you couldn't read, and cite the pages behind the outline.

The `exam-review` MCP prompt provides that workflow. The tools let an agent check the inventory, index missing files, search, read complete pages and build an evidence packet before answering.

| Task | Tools |
| --- | --- |
| Inspect connection and freshness | `connection_status`, `list_courses` |
| Find course material | `list_course_sources`, `course_coverage` |
| Refresh metadata or index documents | `refresh_courses`, `index_course` |
| Follow long operations | `job_status`, `cancel_job`, `resume_job` |
| Retrieve evidence | `search_course_material`, `read_document`, `research_context` |

Tool results include the source URL, page or slide label, text hash, document hash and indexing time. `read_document` accepts the document hash from a search result and rejects a read if that document changed. Long pages have continuation offsets instead of silently losing their trailing text.

`research_context` returns a bounded packet of evidence across matching pages. It does not write an answer. The client model still needs to interpret the evidence, check whether it supports a claim, and cite it.

### Use the CLI directly

Run these from `mcp/`. Replace the example course and source IDs with values returned by your index.

```sh
node cli.mjs call list_courses
node cli.mjs call list_course_sources --args '{"courseId":123,"kind":"file"}'
node cli.mjs call index_course --args '{"courseId":123}' --wait
node cli.mjs call search_course_material --args '{"courseId":123,"query":"first exam scope"}'
node cli.mjs call read_document --args '{"sourceId":"file:123:456"}'
node cli.mjs call read_document --args '{"sourceId":"file:123:456","page":1}'
```

For a few documents, pass `sourceIds` to `index_course`. Omit it to index all stale files in the course. `force: true` downloads unchanged files again, which is useful when the instructor replaced a file without updating its metadata.

The MCP process runs queued jobs in the background. A CLI invocation needs `--wait` to keep running until its job finishes. Without it, the job stays durable and can be picked up by the next `serve` process or another waiting job command. A completed job can still have per-file or metadata failures; check its `failures` and the coverage audit.

## What it reads

The first version supports **current Purdue Brightspace courses**. It discovers supported API versions and reads course names, content structure, posted assignment and quiz instructions, announcements, calendar events, overview text and attached course files.

PDFs retain page locations. Modern Word and PowerPoint files, RTF, HTML, plain text, source files, supported text datasets and notebook cells use the shared BoilerSpace readers. Downloads use the shared 100 MB limit, or 200 MB for Office ZIP containers. Parsing is limited to 2,000 pages, eight million text characters and 30 seconds per file. Notebook cells and source files are read as text. They are never executed.

This version does not connect Ed, Piazza, Gradescope or Simple Syllabus. It does not fetch grade endpoints, submissions, quiz attempts or answer keys. It does not submit, post or change coursework. External links remain in the inventory but are not downloaded. Scanned pages, equations and diagrams can need visual reading, which is not included. A file can contain readable text and still have a warning about incomplete extraction.

## Recovery and data

The default data directory is `~/.local/share/boilerspace-companion`, or `$XDG_DATA_HOME/boilerspace-companion` when set. Override it with `BOILERSPACE_DATA_DIR` or `--data-dir`. Use the same directory for login, CLI calls and the MCP client.

| Situation | What happens |
| --- | --- |
| Purdue sign-in expires | Cached searches and reads still work. Run `login` again, then resume the failed job. An already-running MCP process detects the new sign-in. |
| A file fails | The job records its failure and continues with other files. Run `index_course` again to retry files still missing. |
| A sync section fails | Its earlier sources stay available. Sync errors remain visible rather than replacing that section with an empty inventory. |
| The process stops | A clean shutdown releases its job for immediate recovery. After a crash, another worker can resume after the two-minute lease expires. |
| You cancel indexing | Finished files stay indexed. A job owned by another process observes cancellation on its next checkpoint, with a heartbeat every ten seconds. |
| A document changes | Its previous passages and vectors are invalidated. Old evidence hashes no longer pass a pinned read. |

Refreshes are explicit. Cached material does not update just because an agent searches it. Search results and coverage include the last sync time so the agent can decide when to refresh.

`logout` removes the companion session and its separate browser profile. It **keeps indexed course material**. To remove that too, stop companion processes and delete the chosen data directory. Extension storage is separate.

Cookies, the XSRF token and the dedicated sign-in profile are local credentials. The data directory uses owner-only Unix permissions; it is not an encrypted vault. Session files and course caches must stay out of Git and shared folders. Windows users should use a directory protected by their account's access controls. The companion does not collect passwords or expose credentials through MCP tools.

Tool responses go to the MCP client you connect. That client can send course excerpts to its model provider under its own settings and privacy policy. See [the privacy policy](../PRIVACY.md#standalone-companion).

## How it works

```mermaid
flowchart LR
  Login[Separate Purdue sign-in] --> Session[Local cookie jar]
  Session --> Reader[Restricted Brightspace transport]
  Reader --> Jobs[Resumable sync and indexing jobs]
  Jobs --> Index[SQLite pages, FTS5 and vectors]
  Index --> Tools[Shared research tools]
  Tools --> MCP[MCP over stdio]
  Tools --> CLI[JSON CLI]
```

- **Transport.** Only pinned Purdue routes are accepted. Redirects are refused, downloads are bounded while streaming, and transient failures have limited retries. The only POST mints Brightspace's short-lived API bearer. It does not alter course data.
- **Storage.** SQLite publishes metadata and page replacements transactionally. Job leases prevent two processes from owning the same job. Checkpoints preserve the completed file cursor; source revisions prevent stale jobs from publishing an older document.
- **Retrieval.** SQLite FTS5 BM25 and the bundled local semantic encoder are combined with reciprocal rank fusion. Vectors persist in SQLite. Model assets are checked against pinned hashes, and keyword search stays available if semantic indexing fails.
- **Parsing.** Document parsing runs in a worker with a time limit. PDF decoding uses local PDF.js assets. The companion shares the other readers with the extension, so formats have one implementation.
- **Agent boundary.** Tools accept known course and source IDs, not arbitrary URLs or local paths. Course text is untrusted evidence. The MCP instructions and research prompt tell clients to retain citations, inspect coverage and disregard document instructions directed at the agent. A client model must still enforce that boundary.

This uses Purdue's signed-in web session and the same course API reader as the extension. It is not an institution-registered OAuth application. Changes to Purdue sign-in or Brightspace can require reader updates.

## Development and validation

From `mcp/`:

```sh
npm test
npm run test:browser
npm run eval -- eval-local.json
npm audit --audit-level=high
```

Run `npm run lint` from the repository root. CI checks the companion on Node 22 and 24, including the actual MCP stdio handshake, document parsers, session isolation, durable jobs and an intercepted browser sign-in. Those browser fixtures do not contact Purdue.

[The retrieval evaluation](eval/README.md) compares keyword and hybrid search on a checked-in synthetic corpus, including multi-document questions and course scoping. Its [recorded baseline](eval/baseline.json) includes per-question rankings and timings. It is a regression check, not a claim about real-course answer accuracy.

Live validation uses a separate, ignored data directory. It must not export course captures, credentials or raw API responses into the repository. The package is currently private and runs from a full checkout; it is not a published standalone npm distribution.
