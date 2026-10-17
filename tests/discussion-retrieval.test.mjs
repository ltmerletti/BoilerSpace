import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkRanges, discussionCorpus, effectiveQuery, evaluateRanking, partitionCases, resolveCases } from '../experiments/discussions/corpus.mjs';
import { lexicalIndex } from '../experiments/discussions/lexical.mjs';
import { questionParts, interleave } from '../experiments/discussions/query-planning.mjs';

const discussion = { sources: [{ id: 'ed:test', platform: 'ed', name: 'Example', threads: [{
  key: 'ed:test:1', number: 1, title: 'Submission problem', role: 'student', text: 'Where should I submit the work?',
  replies: [{ id: 'answer', role: 'instructor', text: 'Use the course portal before Friday.', endorsed: true }],
}] }] };
const item = { id: 'example', expected: [{ threadKey: 'ed:test:1', messageId: 'answer', quote: 'course portal before Friday' }] };

test('chunk ranges cover every character without skipping word boundaries', () => {
  const text = 'A moderately long phrase with spaces.\n\n'.repeat(30);
  for (const paragraphs of [false, true]) for (const overlap of [0, 20]) {
    const coverage = new Uint8Array(text.length);
    for (const { start, end } of chunkRanges(text, { size: 80, overlap, paragraphs })) {
      assert.ok(end > start && end - start <= 80);
      coverage.fill(1, start, end);
    }
    assert.ok(coverage.every(Boolean));
  }
  assert.throws(() => chunkRanges(text, { size: 80, overlap: 80 }));
});

test('answer labels map to root and reply characters across both representations', () => {
  const [resolved] = resolveCases(discussion, [item]);
  for (const unit of ['thread', 'message']) {
    const corpus = discussionCorpus(discussion, { unit, size: 80, overlap: 20 });
    const answer = corpus.find((e) => e.text.includes(item.expected[0].quote));
    assert.equal(evaluateRanking(resolved, [answer]).allEvidenceInContext, 1);
    const questionOnly = corpus.filter((e) => e.segments.every((s) => s.messageId === 'root'));
    assert.equal(evaluateRanking(resolved, questionOnly).allEvidenceInContext, 0);
  }
});

test('context truncation and gaps cannot count as complete answer evidence', () => {
  const evidence = { threadKey: 't', messageId: 'r', start: 0, end: 100 };
  const entry = (start, end) => ({ discussion_key: 't', text: 'x'.repeat(end - start), segments: [
    { threadKey: 't', messageId: 'r', start, end, textStart: 0, textEnd: end - start },
  ] });
  const query = { id: 'gap', expected: [evidence] };
  assert.equal(evaluateRanking(query, [entry(0, 100)], { budget: 80 }).allEvidenceInContext, 0);
  assert.equal(evaluateRanking(query, [entry(0, 40), entry(41, 100)]).allEvidenceInContext, 0);
  assert.equal(evaluateRanking(query, [entry(0, 40), entry(40, 100)]).allEvidenceInContext, 1);
});

test('multiple-answer questions require every answer, not one matching thread', () => {
  const [resolved] = resolveCases(discussion, [item]);
  const corpus = discussionCorpus(discussion, { unit: 'message', size: 80, overlap: 20 });
  const answer = corpus.find((e) => e.role === 'instructor');
  const query = { ...resolved, expected: [...resolved.expected, { ...resolved.expected[0], threadKey: 'missing' }] };
  const score = evaluateRanking(query, [answer]);
  assert.equal(score.hitAt1, 1);
  assert.equal(score.allEvidenceInContext, 0);
  assert.equal(score.evidenceRecallInContext, 0.5);
});

test('query history includes only user messages and never leaked assistant answers', () => {
  const query = { query: 'What about Friday?', history: [
    { role: 'user', content: 'Where is submission?' }, { role: 'assistant', content: 'LEAKED ANSWER' },
  ] };
  assert.equal(effectiveQuery(query, 'raw'), 'What about Friday?');
  assert.equal(effectiveQuery(query, 'history'), 'Where is submission?\nWhat about Friday?');
});

test('connected answer threads stay together across the development split', () => {
  const query = (id, keys) => ({ id, expected: keys.map((threadKey) => ({ threadKey })) });
  const cases = partitionCases([query('a', ['one']), query('b', ['two']), query('c', ['one', 'two']), query('d', ['two', 'three'])]);
  assert.equal(new Set(cases.map((c) => c.partition)).size, 1);
  assert.deepEqual(partitionCases([...cases].reverse()).map((c) => c.partition), cases.map((c) => c.partition).reverse());
});

test('lexical search keeps Ed and Piazza classes separate even when courseId is absent', () => {
  const entries = ['ed:a', 'ed:b', 'piazza:c'].map((sourceId, chunkIndex) => ({ sourceId, courseId: null, chunkIndex, title: 'Deadline', text: 'Submit by Friday.' }));
  for (const characters of [false, true]) {
    const index = lexicalIndex(entries, { characters });
    assert.deepEqual(index.search('Friday', { sourceId: 'piazza:c' }).map((e) => e.sourceId), ['piazza:c']);
  }
});

test('invalid evidence quotes fail validation instead of silently changing denominators', () => {
  assert.throws(() => resolveCases(discussion, [{ ...item, expected: [{ ...item.expected[0], quote: 'not in the discussion' }] }]));
  assert.throws(() => resolveCases(discussion, [{ ...item, sourceId: 'piazza:wrong-class' }]), /outside the search scope/);
});

test('separate questions retain user context and interleave without duplicate passages', () => {
  assert.deepEqual(questionParts({ query: 'Where is help and how do I submit?', history: [{ role: 'user', content: 'For class A' }] }),
    ['For class A\nWhere is help ', 'For class A\n how do I submit?']);
  assert.equal(questionParts({ query: 'Can I use arrays and lists?' }).length, 1);
  const a = { id: 'a', chunkIndex: 0 }, b = { id: 'b', chunkIndex: 0 }, c = { id: 'c', chunkIndex: 0 };
  assert.deepEqual(interleave([[a, b], [c, a]]), [a, c, b]);
});
