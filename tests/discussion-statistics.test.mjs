import test from 'node:test';
import assert from 'node:assert/strict';
import { wilson, exactMcNemar, pairedBootstrap, evidenceGroups, comparePaired, holm } from '../experiments/discussions/statistics.mjs';
import { validateBenchmark } from '../experiments/discussions/validate-benchmark.mjs';
import { evaluateRanking } from '../experiments/discussions/corpus.mjs';

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const c = (id, thread, group = null) => ({ id, expected: [{ threadKey: thread }], dependenceGroup: group });

test('Wilson intervals handle all successes, all failures, and a published binomial example', () => {
  const middle = wilson(50, 100);
  near(middle.low, 0.4038315304); near(middle.high, 0.5961684696);
  near(wilson(0, 100).high, 0.0369934982); near(wilson(100, 100).low, 0.9630065018);
  assert.throws(() => wilson(0, 0)); assert.throws(() => wilson(1.5, 10));
});

test('exact McNemar conditions on discordant pairs and handles large balanced samples', () => {
  near(exactMcNemar(10, 0).p, 0.001953125);
  near(exactMcNemar(0, 10).p, 0.001953125);
  near(exactMcNemar(3, 1).p, 0.625);
  near(exactMcNemar(0, 0).p, 1); near(exactMcNemar(1000, 1000).p, 1);
  assert.throws(() => exactMcNemar(-1, 2));
});

test('connected evidence threads and optional source/topic families form bootstrap clusters', () => {
  const cases = [c('a', 'a', 'same'), c('b', 'b', 'same'), c('c', 'c'),
    { id: 'multi', expected: [{ threadKey: 'b' }, { threadKey: 'c' }] }];
  const ordinary = evidenceGroups(cases), topics = evidenceGroups(cases, { topicClusters: true });
  assert.notEqual(ordinary[0], ordinary[1]); assert.equal(ordinary[1], ordinary[2]);
  assert.equal(new Set(topics).size, 1);
  assert.throws(() => evidenceGroups([{ id: 'negative', expected: [] }]));
});

test('paired bootstrap resamples whole unequal clusters and remains deterministic', () => {
  const first = pairedBootstrap([1, 1, -1], ['large', 'large', 'small'], { replicates: 2000 });
  assert.deepEqual(first, pairedBootstrap([1, 1, -1], ['large', 'large', 'small'], { replicates: 2000 }));
  near(first.estimate, 1 / 3); near(first.low, -1); near(first.high, 1); assert.equal(first.clusters, 2);
  assert.throws(() => pairedBootstrap([1], []));
});

test('paired comparisons align by ID rather than row position and reject missing pairs', () => {
  const cases = [c('a', 'a'), c('b', 'b')];
  const a = [{ id: 'a', allEvidenceInContext: 1 }, { id: 'b', allEvidenceInContext: 0 }];
  const b = [{ id: 'b', allEvidenceInContext: 1 }, { id: 'a', allEvidenceInContext: 0 }];
  const result = comparePaired(cases, a, b, { replicates: 100 });
  assert.equal(result.mcnemar.candidateOnly, 1); assert.equal(result.mcnemar.referenceOnly, 1);
  assert.throws(() => comparePaired(cases, a, b.slice(1)));
  assert.throws(() => comparePaired(cases, a, [b[0], b[0]]));
  const combined = [...cases, { id: 'multi', expected: [{ threadKey: 'a' }, { threadKey: 'b' }] }];
  const rows = [...a, { id: 'multi', allEvidenceInContext: 1 }];
  assert.equal(comparePaired(combined, rows, rows, { replicates: 100 }).mcnemar, null);
});

test('Holm adjustments are monotonic in sorted p-values and restored to input order', () => {
  assert.deepEqual(holm([0.04, 0.001, 0.03]), [0.06, 0.003, 0.06]);
  assert.throws(() => holm([NaN]));
});

test('benchmark validation rejects development leakage, duplicate primary threads, and nonstaff evidence', () => {
  const discussions = { sources: [{ id: 'ed:test', threads: [{ key: 't', role: 'student', text: 'question',
    replies: [{ id: 'r', role: 'instructor', text: 'The deadline is Friday.' }] }] }] };
  const item = { id: 'new', sourceId: 'ed:test', query: 'When is it due?', primary: true,
    kind: 'temporal', topic: 'deadline', supportedAnswer: 'Friday', rationale: 'Exact staff answer',
    expected: [{ threadKey: 't', messageId: 'r', quote: 'Friday' }] };
  assert.equal(validateBenchmark(discussions, [item], { primaryCount: 1 }).primaryQuestions, 1);
  assert.throws(() => validateBenchmark(discussions, [item], { development: [item] }), /leakage/);
  assert.throws(() => validateBenchmark(discussions, [item, { ...item, id: 'other', query: 'Which day?' }]), /distinct threads/);
  assert.throws(() => validateBenchmark(discussions, [{ ...item, expected: [{ threadKey: 't', messageId: 'root', quote: 'question' }] }]), /staff/);
  assert.throws(() => validateBenchmark(discussions, [{ ...item, expected: [] }]), /Empty evidence/);
  assert.throws(() => evaluateRanking({ id: 'negative', expected: [] }, []), /Keep diagnostics separate/);
});
