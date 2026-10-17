import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { discussionEncoder } from '../extension/lib/discussion-embedding.js';
import { discussionPassages, discussionIndex, discussionContext } from '../extension/lib/discussion-ranking.js';
import { createDiscussionSearch, DiscussionSearchClient } from '../extension/lib/discussion-search.js';
import { createTools } from '../extension/lib/agent.js';
import { snapshotFixture } from './helpers.mjs';

const capture = (text = 'The report deadline is Friday.', key = 'ed:1:10') => ({ sources: [{ id: 'ed:1', name: 'Course one', courseId: 1600001, threads: [{ key, title: 'Project deadline', text: 'When is the report due?', role: 'student', number: 10, url: 'https://edstem.org/us/courses/1/discussion/10', replies: [{ id: 'r1', role: 'instructor', endorsed: true, text }] }] },
  { id: 'piazza:old', name: 'Older course', courseId: null, threads: [{ key: 'piazza:old:9', number: 9, title: 'Other deadline', text: 'Friday report submission is cancelled.', role: 'student', url: 'https://piazza.com/class/old?cid=9', replies: [] }] }] });

test('discussion chunking retains overlapping reply text and exact source scope', () => {
  const text = 'context '.repeat(250) + 'UNIQUEANSWER', entries = discussionPassages(capture(text));
  assert.ok(entries.some(e => e.text.includes('UNIQUEANSWER')));
  assert.ok(entries.every(e => e.text.length <= 1000));
  const index = discussionIndex(entries);
  assert.ok(index.rank('Friday', { courseId: 1600001 }).every(e => e.sourceId === 'ed:1'));
  assert.ok(index.rank('Friday', { sourceId: 'piazza:old' }).every(e => e.courseId === null));
  assert.equal(index.rank('deadline', { sourceId: 'piazza:old', courseId: 1600001 }).length, 0);
  assert.equal(index.rank('', {}).length, 0);
});

test('the discussion context limits text to 6000 characters and twelve passages', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, text: 'x'.repeat(777) }));
  const context = discussionContext(rows);
  assert.ok(context.length <= 12);
  assert.equal(context.reduce((sum, e) => sum + e.text.length, 0), 6000);
  assert.equal(discussionContext(rows.map(e => ({ ...e, text: 'abc' }))).length, 12);
});

test('search results open a matching late reply directly, including text beyond the old capture limit', async () => {
  const data = capture();
  const thread = data.sources[0].threads[0];
  thread.replies = Array.from({ length: 120 }, (_, i) => ({ id: `reply-${i}`, role: 'instructor', text: i === 119 ? 'background '.repeat(5000) + 'UNIQUECLARIFICATION: Friday at 5 PM.' : `Earlier comment ${i}.` }));
  const entries = discussionPassages(data);
  const target = entries.find(entry => entry.text.includes('UNIQUECLARIFICATION'));
  assert.equal(target.read_targets[0].reply_id, 'reply-119');
  assert.ok(target.read_targets[0].offset > 40_000);
  const tools = createTools({ snapshot: snapshotFixture(), discussions: data });
  const search = await tools.run('search_course_material', { query: 'UNIQUECLARIFICATION', source_id: 'ed:1' });
  const match = search.results.find(result => result.snippet.includes('UNIQUECLARIFICATION'));
  assert.deepEqual(match.read_targets, target.read_targets);
  const read = await tools.run('read_discussion', { discussion_key: match.discussion_key, ...match.read_targets[0] });
  assert.ok(read.text.includes('UNIQUECLARIFICATION: Friday at 5 PM.'));
  assert.equal(read.author_role, 'instructor');
  assert.equal(tools.sources.get(read.source).url, thread.url);
});

test('semantic-only candidates survive fusion and cannot cross course or source boundaries', () => {
  const entries = [{ id: 'a', courseId: 1, sourceId: 'ed:1', title: 'Paper', text: 'The room changed.' }, { id: 'b', courseId: 1, sourceId: 'ed:1', title: 'Notebook', text: 'Restart the kernel.' }, { id: 'c', courseId: null, sourceId: 'piazza:old', title: 'Other class', text: 'Restart the kernel.' }];
  const index = discussionIndex(entries), model = { encoder: { dimensions: 2, encode: () => new Float32Array([0, 1]) }, vectors: new Float32Array([1, 0, 0, 1, 0, 1]) };
  assert.equal(index.rank('lost variables', { sourceId: 'ed:1' }, model)[0].id, 'b');
  assert.equal(index.rank('lost variables', { courseId: 1 }, model).some(e => e.id === 'c'), false);
  assert.throws(() => index.rank('test', {}, { ...model, vectors: new Float32Array(1) }), /do not match/);
});

test('packaged public model and tokenizer match the pinned distribution hashes', () => {
  for (const [file, expected] of [['potion/model-i8.safetensors', '796f9def7a06baabb842ed18efbce1331f3744a0a77dc5404e82ac8e5f41805e'], ['potion/tokenizer.json', '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18'], ['tokenizers/tokenizers.mjs', '1c4a848f86156201c033d6cd08c4cf81ae1088552acec3367f31ef086edf5af0']]) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../extension/vendor/${file}`, import.meta.url))).digest('hex'), expected);
  }
});

test('compressed embeddings exclude unknown tokens, handle empty input, and reject damaged offsets', async () => {
  const bytes = readFileSync(new URL('../extension/vendor/potion/model-i8.safetensors', import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const encoder = discussionEncoder({ encode: () => ({ ids: [1] }) }, buffer);
  assert.ok(encoder.encode('☃').every(v => v === 0));
  const invalid = buffer.slice(0, 1000);
  assert.throws(() => discussionEncoder({}, invalid), /offsets/);
  assert.throws(() => discussionEncoder({}, new ArrayBuffer(1)), /Invalid/);
  const badToken = discussionEncoder({ encode: () => ({ ids: [999999] }) }, buffer);
  assert.throws(() => badToken.encode('text'), /vocabulary/);
});

test('unavailable semantic search returns scoped keyword evidence and an explicit fallback note', async () => {
  const retrieve = createDiscussionSearch(capture(), { searchClient: { search: async () => { throw new Error('Missing model.'); } } });
  const result = await retrieve('report Friday', { sourceId: 'ed:1' });
  assert.equal(result.method, 'bm25');
  assert.match(result.note, /keyword/);
  assert.ok(result.results.length);
  assert.ok(result.results.every(e => e.sourceId === 'ed:1'));
  assert.ok(result.results[0].text.includes('instructor endorsed:'));
});

test('a source invalidated during search returns no old or disconnected evidence', async () => {
  const fake = { revision: 1, search: async () => { fake.revision++; throw new Error('Changed.'); } };
  const result = await createDiscussionSearch(capture(), { searchClient: fake })('report', {});
  assert.equal(result.results.length, 0);
  assert.match(result.note, /changed/);
});

test('the worker is reused, receives replaced corpora, releases memory when idle, and restarts', async () => {
  const sent = [], workers = [];
  const client = new DiscussionSearchClient({ idleMs: 15, workerFactory: () => {
    const worker = { terminated: false, terminate() { this.terminated = true; }, postMessage(message) { sent.push(message); queueMicrotask(() => this.onmessage({ data: { id: message.id, result: { results: [], method: 'potion-i8-bm25' } } })); } };
    workers.push(worker); return worker;
  } });
  try {
    await client.search(['old'], 'one', 'first', {});
    await client.search(['old'], 'one', 'second', {});
    await client.search(['new'], 'two', 'third', {});
    assert.deepEqual(sent.map(m => m.entries), [['old'], undefined, ['new']]);
    assert.equal(workers.length, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(workers[0].terminated);
    await client.search(['new'], 'two', 'fourth', {});
    assert.equal(workers.length, 2);
    assert.deepEqual(sent[3].entries, ['new']);
  } finally { client.dispose(); }
});

test('a stalled worker times out, terminates, and does not leave future searches waiting', async () => {
  let terminated = false;
  const client = new DiscussionSearchClient({ timeoutMs: 10, retryMs: 0, workerFactory: () => ({ postMessage() {}, terminate() { terminated = true; } }) });
  await assert.rejects(client.search([], 'hash', 'test', {}), /stopped/);
  assert.ok(terminated); assert.equal(client.pending.size, 0);
  client.workerFactory = () => ({ postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id, result: { results: [] } } })); }, terminate() {} });
  try { assert.deepEqual((await client.search([], 'hash', 'test', {})).results, []); }
  finally { client.dispose(); }
});

test('a failed model load backs off and then retries with a fresh worker', async () => {
  let created = 0, terminated = 0;
  const client = new DiscussionSearchClient({ retryMs: 20, workerFactory: () => {
    const first = ++created === 1;
    return { terminate() { terminated++; }, postMessage(message) { queueMicrotask(() => this.onmessage({ data: first ? { id: message.id, error: 'Invalid model.' } : { id: message.id, result: { results: [] } } })); } };
  } });
  try {
    await assert.rejects(client.search([], 'hash', 'test', {}), /Invalid model/);
    await assert.rejects(client.search([], 'hash', 'test', {}), /retry is waiting/);
    assert.equal(created, 1); assert.equal(terminated, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual((await client.search([], 'hash', 'test', {})).results, []);
    assert.equal(created, 2);
  } finally { client.dispose(); }
});

test('Ask keeps evidence after character 700 and supports an explicit unlinked discussion source', async () => {
  const discussions = capture('report '.repeat(110) + 'ANSWER_AFTER_700');
  const tools = createTools({ snapshot: snapshotFixture(), discussions });
  const result = await tools.run('search_course_material', { query: 'report ANSWER_AFTER_700', source_id: 'ed:1' });
  assert.ok(result.results.every(r => r.kind === 'discussion'));
  assert.ok(result.results.some(r => r.snippet.includes('ANSWER_AFTER_700')));
  assert.ok(result.results.reduce((sum, r) => sum + r.snippet.length, 0) <= 6000);
  const other = await tools.run('search_course_material', { query: 'report', source_id: 'piazza:old' });
  assert.ok(other.results.every(r => r.discussion_key === 'piazza:old:9'));
  const again = await tools.run('search_course_material', { query: 'report ANSWER_AFTER_700 deadline', source_id: 'ed:1' });
  assert.ok(again.results, 'discussion paraphrases are not blocked by the course-file loop guard');
});
