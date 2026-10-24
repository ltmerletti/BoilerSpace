import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { CourseDatabase, digest } from '../lib/database.mjs';
import { Retrieval } from '../lib/retrieval.mjs';
import { ORIGIN } from '../lib/config.mjs';
import { documents, questions } from './cases.mjs';

const database = new CourseDatabase(':memory:');
const records = documents.map(([courseId, id, title]) => ({ id: `file:${courseId}:${id}`, courseId, kind: 'file', title,
  url: `${ORIGIN}/d2l/home/${courseId}`, metadata: {}, revision: digest([courseId, id, title]) }));
database.publish({ courses: [101, 202].map(id => ({ id, current: true, name: `Synthetic ${id}` })), data: [], errors: [], versions: {} }, records);
for (const [index, document] of documents.entries()) database.savePages(records[index].id, records[index].revision, [{ label: 'page 1', text: document[3] }]);
const retrieval = new Retrieval(database);
const started = performance.now();
try {
  await retrieval.index();
  const indexMilliseconds = performance.now() - started;
  const methods = {};
  for (const method of ['bm25', 'hybrid']) {
    const measurements = [];
    for (const [courseId, query, expected] of questions) {
      const start = performance.now();
      const results = method === 'bm25' ? database.search(query, { courseId, limit: 5 }) : (await retrieval.search(query, { courseId, limit: 5 })).results;
      const milliseconds = performance.now() - start;
      const ids = results.map(hit => hit.source.sourceId.split(':').at(-1));
      const rank = ids.findIndex(id => expected.includes(id));
      const found = expected.filter(id => ids.includes(id)).length;
      measurements.push({ query, courseId, expected, retrieved: ids, hit1: Number(expected.includes(ids[0])), hit5: Number(rank >= 0),
        reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1), evidenceRecall5: found / expected.length, allEvidence5: Number(found === expected.length), milliseconds });
    }
    const mean = key => measurements.reduce((sum, result) => sum + result[key], 0) / measurements.length;
    const times = measurements.map(row => row.milliseconds).sort((a, b) => a - b);
    methods[method] = { hit1: mean('hit1'), hit5: mean('hit5'), mrr: mean('reciprocalRank'), evidenceRecall5: mean('evidenceRecall5'), allEvidence5: mean('allEvidence5'),
      queryMilliseconds: { p50: times[Math.floor(times.length * 0.5)], p95: times[Math.floor(times.length * 0.95)] }, cases: measurements };
  }
  const report = { benchmark: 'companion-synthetic-v1', datasetHash: digest([documents, questions]), documents: documents.length, questions: questions.length,
    node: process.version, platform: `${process.platform}-${process.arch}`, indexMilliseconds, methods,
    limits: 'Small synthetic retrieval regression set. Does not measure real-course answer correctness, citation entailment, SSO reliability, or statistical significance. Latency is hardware-dependent.' };
  const target = process.argv[2];
  if (target) await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, methods: Object.fromEntries(Object.entries(methods).map(([name, { cases: _cases, ...summary }]) => [name, summary])) }, null, 2));
} finally { retrieval.close(); database.close(); }
