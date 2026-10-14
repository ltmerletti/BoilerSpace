#!/usr/bin/env node
// Offline check of read_course_file passage selection. For every case whose evidence sits in a course file,
// replays the queries the model sent for that file in saved runs (plus the case question itself) and reports
// how often the evidence quote comes back in the excerpts. No network calls.
//
//   node bench/retrieval.mjs [--runs a.json,b.json] [--verbose]

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTools } from '../extension/lib/agent.js';
import { normalizeForMatch } from '../extension/lib/syllabus.js';
import { DEFAULT_CAPTURE_PATH, loadCapture } from './load.mjs';
import { DEFAULT_CASES_PATH, RUNS_DIR } from './run.mjs';

const PROBE_CHARS = 60;

// A long quote can straddle two chunks, so look for any probe-sized slice of it.
export function quoteFound(quote, texts) {
  const q = normalizeForMatch(quote);
  const haystack = texts.map(normalizeForMatch);
  if (q.length <= PROBE_CHARS) return haystack.some((t) => t.includes(q));
  const probes = [];
  for (let i = 0; i + PROBE_CHARS <= q.length; i += Math.floor(PROBE_CHARS / 2)) probes.push(q.slice(i, i + PROBE_CHARS));
  return probes.some((p) => haystack.some((t) => t.includes(p)));
}

function fileKeyFor(evidence, testCase) {
  if (evidence.topicId === 'overview') return testCase.scopeCourseId ? `overview:${testCase.scopeCourseId}` : null;
  return typeof evidence.topicId === 'number' || /^\d+$/.test(String(evidence.topicId ?? '')) ? `content:${evidence.topicId}` : null;
}

export async function retrievalReport({ env, cases, runs }) {
  const queriesByFile = new Map();
  for (const run of runs) {
    for (const c of run.cases ?? []) {
      for (const step of c.trace ?? []) {
        if (step.type !== 'tool' || step.name !== 'read_course_file' || !step.args?.query) continue;
        const key = `${c.id}|${step.args.file_key}`;
        if (!queriesByFile.has(key)) queriesByFile.set(key, new Set());
        queriesByFile.get(key).add(step.args.query);
      }
    }
  }

  const rows = [];
  for (const testCase of cases) {
    for (const evidence of testCase.evidence ?? []) {
      const fileKey = fileKeyFor(evidence, testCase);
      if (!fileKey) continue;
      const queries = new Set([testCase.question, ...(queriesByFile.get(`${testCase.id}|${fileKey}`) ?? [])]);
      for (const query of queries) {
        const tools = createTools({ snapshot: env.snapshot, syllabi: env.syllabi, now: new Date(testCase.now), ...env.session() });
        const res = await tools.run('read_course_file', { file_key: fileKey, query });
        if (!res.excerpts) continue;
        const found = quoteFound(evidence.quote, res.excerpts.map((e) => e.text));
        rows.push({ id: testCase.id, fileKey, location: evidence.location, query, found, chars: JSON.stringify(res).length });
      }
    }
  }
  return rows;
}

async function main(argv = process.argv.slice(2)) {
  const verbose = argv.includes('--verbose');
  const runsArg = argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length);
  const runFiles = runsArg
    ? runsArg.split(',')
    : readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).map((f) => fileURLToPath(new URL(f, RUNS_DIR)));
  const runs = runFiles.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const env = loadCapture(DEFAULT_CAPTURE_PATH);
  const cases = JSON.parse(readFileSync(DEFAULT_CASES_PATH, 'utf8'));

  const rows = await retrievalReport({ env, cases, runs });
  const hit = rows.filter((r) => r.found).length;
  const avgChars = Math.round(rows.reduce((s, r) => s + r.chars, 0) / (rows.length || 1));
  console.log(`Evidence returned for ${hit} of ${rows.length} file queries (${((hit / (rows.length || 1)) * 100).toFixed(1)}%), average result ${avgChars} chars.`);
  if (verbose) for (const r of rows.filter((x) => !x.found)) console.log(`  MISS ${r.id} ${r.fileKey} (${r.location}): ${r.query}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
