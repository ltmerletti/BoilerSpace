#!/usr/bin/env node
// Benchmark runner for BoilerSpace's course assistant (extension/lib/agent.js).
// Supports live runs against Purdue GenAI Studio (using GENAI_STUDIO_KEY) and an offline --check mode.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ask } from '../extension/lib/agent.js';
import { DEFAULT_MODEL, GENAI_BASE, readEventStream } from '../extension/lib/genai.js';
import { normalizeForMatch } from '../extension/lib/syllabus.js';
import { DEFAULT_CAPTURE_PATH, loadCapture } from './load.mjs';
import { aggregateScores, scoreCase } from './score.mjs';

export const DEFAULT_CASES_PATH = new URL('./data/cases.json', import.meta.url);
export const RUNS_DIR = new URL('./runs/', import.meta.url);

const MIN_REQUEST_SPACING_MS = 3100;
const MAX_RATE_LIMIT_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 180_000;

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    model: DEFAULT_MODEL,
    cases: null,
    category: null,
    limit: null,
    concurrency: 3,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--model' && argv[i + 1]) {
      opts.model = argv[++i];
    } else if (arg.startsWith('--model=')) {
      opts.model = arg.slice('--model='.length);
    } else if (arg === '--cases' && argv[i + 1]) {
      opts.cases = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--cases=')) {
      opts.cases = arg.slice('--cases='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--category' && argv[i + 1]) {
      opts.category = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--category=')) {
      opts.category = arg.slice('--category='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--limit' && argv[i + 1]) {
      opts.limit = Number(argv[++i]);
    } else if (arg.startsWith('--limit=')) {
      opts.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--concurrency' && argv[i + 1]) {
      opts.concurrency = Math.max(1, Number(argv[++i]) || 1);
    } else if (arg.startsWith('--concurrency=')) {
      opts.concurrency = Math.max(1, Number(arg.slice('--concurrency='.length)) || 1);
    }
  }
  return opts;
}

export function filterCases(allCases, { cases = null, category = null, limit = null } = {}) {
  let list = [...allCases];
  if (cases?.length) {
    const set = new Set(cases);
    list = list.filter((c) => set.has(c.id));
  }
  if (category?.length) {
    const set = new Set(category);
    list = list.filter((c) => set.has(c.category));
  }
  if (Number.isFinite(limit) && limit > 0) {
    list = list.slice(0, limit);
  }
  return list;
}

// Creates a rate-limited complete() function that POSTs to GenAI Studio with stream:true.
export function createLiveComplete({
  apiKey = process.env.GENAI_STUDIO_KEY,
  model = DEFAULT_MODEL,
  minSpacingMs = MIN_REQUEST_SPACING_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    throw new Error('GENAI_STUDIO_KEY environment variable is required for live benchmark runs.');
  }

  let lastRequestAt = 0;
  let totalRequests = 0;

  async function complete(body, { signal = null, onDelta = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      const slot = Math.max(Date.now(), lastRequestAt + minSpacingMs);
      lastRequestAt = slot;
      if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
      totalRequests += 1;

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const res = await fetchImpl(`${GENAI_BASE}/api/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          ...body,
          stream: true,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // GenAI Studio sometimes reports its rate limit as a 400 rather than a 429.
        const limited = res.status === 429 || /rate limit/i.test(text);
        if (limited && attempt < MAX_RATE_LIMIT_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after')) || 4 * 2 ** attempt;
          lastRequestAt = Math.max(lastRequestAt, Date.now() + retryAfter * 1000);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw new Error(`GenAI Studio HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('event-stream') || res.body) {
        return readEventStream(res.body, onDelta ?? (() => {}));
      }

      const json = await res.json();
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error('GenAI Studio returned no message.');
      const reasoning = message.reasoning_content ?? message.reasoning;
      return reasoning ? { ...message, reasoning } : message;
    }
  }

  return {
    complete,
    getRequestCount: () => totalRequests,
  };
}

// Finds candidate texts in the capture for an evidence entry { topicId | itemKey, location, quote }.
function candidateTextsForEvidence(capture, ev, scopeCourseId = null) {
  if (ev.topicId !== undefined && ev.topicId !== null) {
    const scoped = (capture.files ?? []).filter(
      (f) => String(f.topicId) === String(ev.topicId) && (!scopeCourseId || ev.topicId !== 'overview' || f.courseId === scopeCourseId),
    );
    const matchingFiles = scoped.length ? scoped : (capture.files ?? []).filter((f) => String(f.topicId) === String(ev.topicId));
    const texts = [];
    for (const file of matchingFiles) {
      if (file.error) texts.push(file.error);
      for (const page of file.pages ?? []) {
        if (!ev.location || page.label === ev.location) {
          texts.push(page.text ?? '');
        }
      }
    }
    return texts;
  }

  if (ev.itemKey) {
    const key = String(ev.itemKey);
    const [kind, rawId] = key.split(':');
    const texts = [];
    for (const d of capture.data ?? []) {
      if (kind === 'quiz') {
        const q = (d.quizzes ?? []).find((x) => String(x.id) === rawId);
        if (q) texts.push(q.title ?? '', q.instructions ?? '', q.dueAt ?? '', q.endAt ?? '', JSON.stringify(q));
      } else if (kind === 'assignment') {
        const a = (d.assignments ?? []).find((x) => String(x.id) === rawId);
        if (a) texts.push(a.title ?? '', a.instructions ?? '', a.dueAt ?? '', JSON.stringify(a));
      } else if (kind === 'event') {
        const e = (d.events ?? []).find((x) => String(x.id) === rawId);
        if (e) texts.push(e.title ?? '', e.description ?? '', e.startAt ?? '', e.endAt ?? '', JSON.stringify(e));
      } else if (kind === 'announcement') {
        const a = (d.announcements ?? []).find((x) => String(x.id) === rawId);
        if (a) texts.push(a.title ?? '', a.body ?? '', a.postedAt ?? '', JSON.stringify(a));
      } else if (kind === 'content') {
        const t = (d.content ?? []).find((x) => String(x.id) === rawId);
        if (t) texts.push(t.title ?? '', (t.modulePath ?? []).join(' / '), JSON.stringify(t));
      }
    }
    for (const syl of Object.values(capture.syllabi ?? {})) {
      const dl = (syl?.deadlines ?? []).find((x) => x.id === key);
      if (dl) {
        texts.push(dl.quote ?? '', dl.title ?? '');
        for (const p of syl.pages ?? []) {
          if (!ev.location || p.label === ev.location) texts.push(p.text ?? '');
        }
      }
    }
    return texts;
  }

  return [];
}

// Validates cases.json schema, unique IDs, regex validity, and that every evidence quote appears in capture.json.
export function validateCases(cases, capture) {
  const errors = [];
  if (!Array.isArray(cases)) {
    return { valid: false, errors: ['cases.json must be a JSON array.'] };
  }
  if (cases.length < 50 || cases.length > 70) {
    errors.push(`Expected 50 to 70 cases, found ${cases.length}.`);
  }

  const seenIds = new Set();
  const courseIds = new Set((capture.courses ?? []).map((c) => c.id));

  for (const [idx, c] of cases.entries()) {
    const label = c?.id ? `case "${c.id}"` : `case #${idx + 1}`;
    if (!c || typeof c !== 'object') {
      errors.push(`${label}: must be an object.`);
      continue;
    }
    if (!c.id || typeof c.id !== 'string') {
      errors.push(`${label}: missing string id.`);
    } else if (seenIds.has(c.id)) {
      errors.push(`${label}: duplicate id "${c.id}".`);
    } else {
      seenIds.add(c.id);
    }

    if (!c.category || typeof c.category !== 'string') {
      errors.push(`${label}: missing string category.`);
    }
    if (!c.question || typeof c.question !== 'string') {
      errors.push(`${label}: missing string question.`);
    }
    if (!c.now || typeof c.now !== 'string' || Number.isNaN(Date.parse(c.now))) {
      errors.push(`${label}: invalid ISO date in "now" (${c.now}).`);
    }
    if (c.scopeCourseId !== undefined && c.scopeCourseId !== null && !courseIds.has(c.scopeCourseId)) {
      errors.push(`${label}: scopeCourseId ${c.scopeCourseId} is not in capture.courses.`);
    }
    if (c.history !== undefined) {
      if (!Array.isArray(c.history) || !c.history.every((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')) {
        errors.push(`${label}: invalid history array.`);
      }
    }

    if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
      errors.push(`${label}: must have a non-empty evidence array.`);
    } else {
      for (const [eIdx, ev] of c.evidence.entries()) {
        if (!ev || (ev.topicId === undefined && !ev.itemKey)) {
          errors.push(`${label} evidence[${eIdx}]: must specify topicId or itemKey.`);
          continue;
        }
        if (!ev.location || typeof ev.location !== 'string') {
          errors.push(`${label} evidence[${eIdx}]: missing string location.`);
        }
        if (!ev.quote || typeof ev.quote !== 'string') {
          errors.push(`${label} evidence[${eIdx}]: missing string quote.`);
          continue;
        }
        const texts = candidateTextsForEvidence(capture, ev, c.scopeCourseId);
        const normQuote = normalizeForMatch(ev.quote);
        if (!normQuote || !texts.some((t) => normalizeForMatch(t).includes(normQuote))) {
          errors.push(`${label} evidence[${eIdx}]: quote not found in capture at ${ev.topicId ?? ev.itemKey} (${ev.location}): "${ev.quote}"`);
        }
      }
    }

    if (!c.expect || typeof c.expect !== 'object') {
      errors.push(`${label}: missing expect object.`);
    } else {
      const { mustInclude, mustNotInclude, citeTopicIds, notFound } = c.expect;
      if (!Array.isArray(mustInclude) || mustInclude.length === 0) {
        errors.push(`${label}: expect.mustInclude must be a non-empty array of regex strings.`);
      } else {
        for (const pat of mustInclude) {
          try {
            new RegExp(pat, 'i');
          } catch (err) {
            errors.push(`${label}: invalid mustInclude regex "${pat}": ${err.message}`);
          }
        }
      }
      if (!Array.isArray(mustNotInclude)) {
        errors.push(`${label}: expect.mustNotInclude must be an array of regex strings.`);
      } else {
        for (const pat of mustNotInclude) {
          try {
            new RegExp(pat, 'i');
          } catch (err) {
            errors.push(`${label}: invalid mustNotInclude regex "${pat}": ${err.message}`);
          }
        }
      }
      if (citeTopicIds !== undefined && !Array.isArray(citeTopicIds)) {
        errors.push(`${label}: expect.citeTopicIds must be an array when provided.`);
      }
      if (notFound !== undefined && typeof notFound !== 'boolean') {
        errors.push(`${label}: expect.notFound must be a boolean when provided.`);
      }
    }
  }

  // Ensure all real student questions from capture.questions are represented in cases.json.
  const caseQuestions = new Set(cases.map((c) => c.question.trim()));
  for (const q of capture.questions ?? []) {
    if (!caseQuestions.has(String(q).trim())) {
      errors.push(`Student question from capture.questions is missing from cases.json: "${q}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// Builds aReadableStream of SSE chunks to exercise readEventStream in --check mode.
function sseStreamFromMessage(message) {
  const lines = [];
  if (message.reasoning) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: message.reasoning } }] })}\n\n`);
  }
  if (message.tool_calls?.length) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: message.tool_calls.map((tc, index) => ({ index, id: tc.id, type: 'function', function: tc.function })) } }] })}\n\n`);
  }
  if (message.content) {
    const mid = Math.ceil(message.content.length / 2);
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content.slice(0, mid) } }] })}\n\n`);
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content.slice(mid) } }] })}\n\n`);
  }
  lines.push('data: [DONE]\n\n');
  const bytes = new TextEncoder().encode(lines.join(''));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// Runs a few representative cases with a scripted fake complete() (and SSE parsing via readEventStream)
// to verify the full plumbing without making network calls.
export async function runPlumbingCheck(cases, env) {
  const { capture, snapshot, syllabi } = env;
  const failedFiles = (capture.files ?? []).filter((f) => f.error && f.topicId !== 'overview');
  const unreadable = cases.find((c) => c.category === 'negative' && failedFiles.some((f) => f.courseId === c.scopeCourseId));
  const failedFile = failedFiles.find((f) => f.courseId === unreadable?.scopeCourseId);
  const targetIds = [
    cases[0]?.id,
    cases[2]?.id,
    cases.find((c) => c.category === 'policies')?.id,
    unreadable?.id,
  ].filter(Boolean);

  const results = [];
  for (const id of targetIds) {
    const testCase = cases.find((c) => c.id === id);
    if (!testCase) throw new Error(`Plumbing check case "${id}" not found in cases.json.`);

    let turn = 0;
    const complete = async (body, { onDelta } = {}) => {
      turn += 1;
      let scripted;
      if (id === targetIds[0]) {
        if (turn === 1) {
          scripted = {
            reasoning: 'Let me check the course files for the project handout.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_course_files', arguments: JSON.stringify({ course_id: testCase.scopeCourseId, query: 'Project' }) } }],
          };
        } else if (turn === 2) {
          scripted = {
            tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_course_file', arguments: JSON.stringify({ file_key: `content:${testCase.evidence[0].topicId}`, query: testCase.evidence[0].quote }) } }],
          };
        } else {
          const toolMsg = JSON.parse(body.messages.at(-1).content);
          const excerpt = toolMsg.excerpts?.[0] ?? { text: '', source: 'S1' };
          scripted = {
            content: `${excerpt.text} [${excerpt.source}]`,
          };
        }
      } else if (id === targetIds[1]) {
        if (turn === 1) {
          scripted = {
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_upcoming', arguments: JSON.stringify({ days: 7 }) } }],
          };
        } else {
          const items = JSON.parse(body.messages.at(-1).content);
          scripted = {
            content: items.map((i) => `${i.title}: ${i.due_display} [${i.source}]`).join('; '),
          };
        }
      } else if (id === targetIds[2]) {
        if (turn === 1) {
          scripted = {
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_course_file', arguments: JSON.stringify({ file_key: `overview:${testCase.scopeCourseId}`, query: testCase.evidence.map((e) => e.quote).join(' ') }) } }],
          };
        } else {
          const toolMsg = JSON.parse(body.messages.at(-1).content);
          const text = (toolMsg.excerpts ?? []).map((e) => `${e.text} [${e.source}]`).join('\n');
          scripted = {
            content: text,
          };
        }
      } else {
        if (turn === 1) {
          scripted = {
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_course_file', arguments: JSON.stringify({ file_key: `content:${failedFile.topicId}`, query: testCase.question }) } }],
          };
        } else {
          const toolMsg = JSON.parse(body.messages.at(-1).content);
          scripted = {
            content: `I could not open the file: ${toolMsg.error}`,
          };
        }
      }

      // Pass the scripted response through readEventStream to verify SSE streaming integration.
      const stream = sseStreamFromMessage(scripted);
      return readEventStream(stream, onDelta ?? (() => {}));
    };

    const start = Date.now();
    const res = await ask({
      question: testCase.question,
      history: testCase.history ?? [],
      snapshot,
      syllabi,
      reviews: {},
      scopeCourseId: testCase.scopeCourseId ?? null,
      now: new Date(testCase.now),
      ...env.session(),
      complete,
    });
    const latencyMs = Date.now() - start;
    const score = scoreCase(testCase, res);
    results.push({
      id: testCase.id,
      category: testCase.category,
      turns: turn,
      latencyMs,
      text: res.text,
      citations: res.citations,
      trace: res.trace,
      score,
    });
  }

  return results;
}

export function formatSummaryTable(summary) {
  const rows = Object.entries(summary.byCategory).map(([cat, s]) => ({
    category: cat,
    passed: s.passed,
    total: s.total,
    rate: `${s.passRate.toFixed(1)}%`,
  }));
  const width = Math.max(18, ...rows.map((r) => r.category.length));
  const lines = [
    `${'Category'.padEnd(width)}  ${'Pass'.padStart(6)}  ${'Total'.padStart(6)}  ${'Rate'.padStart(7)}`,
    `${'-'.repeat(width)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(7)}`,
    ...rows.map((r) => `${r.category.padEnd(width)}  ${String(r.passed).padStart(6)}  ${String(r.total).padStart(6)}  ${r.rate.padStart(7)}`),
    `${'-'.repeat(width)}  ${'-'.repeat(6)}  ${'-'.repeat(6)}  ${'-'.repeat(7)}`,
    `${'TOTAL'.padEnd(width)}  ${String(summary.passed).padStart(6)}  ${String(summary.total).padStart(6)}  ${`${summary.passRate.toFixed(1)}%`.padStart(7)}`,
  ];
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const env = loadCapture(DEFAULT_CAPTURE_PATH);
  const allCases = JSON.parse(readFileSync(DEFAULT_CASES_PATH, 'utf8'));

  if (opts.check) {
    const validation = validateCases(allCases, env.capture);
    if (!validation.valid) {
      console.error('Validation failed:');
      for (const err of validation.errors) console.error(`  - ${err}`);
      process.exitCode = 1;
      return;
    }

    const byCategory = {};
    for (const c of allCases) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;

    console.log(`Validated ${allCases.length} benchmark cases against capture.json (0 errors).`);
    console.log('Cases by category:');
    for (const [cat, count] of Object.entries(byCategory)) {
      console.log(`  ${cat.padEnd(20)} ${count}`);
    }

    const plumbingResults = await runPlumbingCheck(allCases, env);
    const plumbingSummary = aggregateScores(plumbingResults.map((r) => r.score));
    console.log(`\nPlumbing check (${plumbingResults.length} scripted cases via ask() + readEventStream):`);
    console.log(formatSummaryTable(plumbingSummary));

    if (plumbingSummary.failed > 0) {
      for (const r of plumbingResults.filter((x) => !x.score.pass)) {
        console.error(`  FAILED ${r.id}: ${r.score.reasons.join('; ')}`);
      }
      process.exitCode = 1;
    }
    return;
  }

  const selected = filterCases(allCases, opts);
  if (!selected.length) {
    console.error('No benchmark cases matched the provided filters.');
    process.exitCode = 1;
    return;
  }

  const { complete, getRequestCount } = createLiveComplete({
    apiKey: process.env.GENAI_STUDIO_KEY,
    model: opts.model,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(RUNS_DIR, { recursive: true });
  const runPath = new URL(`./${timestamp}.json`, RUNS_DIR);
  const caseRuns = [];
  const save = () => {
    const report = {
      timestamp: new Date().toISOString(),
      model: opts.model,
      complete: caseRuns.length === selected.length,
      totalRequests: getRequestCount(),
      summary: aggregateScores(caseRuns.map((r) => r.score)),
      cases: caseRuns,
    };
    writeFileSync(runPath, JSON.stringify(report, null, 2) + '\n');
    return report;
  };

  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const i = next++;
      caseRuns.push(await runCase(selected[i], i));
      save();
    }
  };

  const runCase = async (testCase, i) => {
    let requests = 0;
    const counted = (body, options) => {
      requests += 1;
      return complete(body, options);
    };
    const start = Date.now();
    let result;
    let error = null;
    try {
      result = await ask({
        question: testCase.question,
        history: testCase.history ?? [],
        snapshot: env.snapshot,
        syllabi: env.syllabi,
        reviews: {},
        scopeCourseId: testCase.scopeCourseId ?? null,
        now: new Date(testCase.now),
        ...env.session(),
        complete: counted,
      });
    } catch (err) {
      error = err.message;
      result = { text: '', citations: [], trace: [] };
    }
    const latencyMs = Date.now() - start;
    const score = scoreCase(testCase, result);
    if (error) {
      score.pass = false;
      score.reasons.push(`runtime error: ${error}`);
    }
    const status = score.pass ? 'PASS' : 'FAIL';
    console.log(`[${i + 1}/${selected.length}] ${status} ${testCase.id} (${requests} reqs, ${latencyMs} ms)`);
    if (!score.pass) {
      console.log(`    reasons: ${score.reasons.join('; ')}`);
    }
    return {
      id: testCase.id,
      category: testCase.category,
      question: testCase.question,
      now: testCase.now,
      scopeCourseId: testCase.scopeCourseId ?? null,
      answer: result.text,
      citations: result.citations,
      trace: result.trace,
      requests,
      latencyMs,
      score,
      ...(error ? { error } : {}),
    };
  };

  console.log(`Writing results to ${fileURLToPath(runPath)} as cases finish.`);
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, selected.length) }, worker));
  const { summary } = save();

  console.log('\nSummary:');
  console.log(formatSummaryTable(summary));
  console.log(`\nSaved run log to ${fileURLToPath(runPath)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
