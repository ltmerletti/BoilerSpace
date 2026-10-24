import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AGENT_TOOLS } from '../../extension/lib/agent.js';
import { CourseDatabase } from '../lib/database.mjs';
import { CourseService, sourcesFromSnapshot } from '../lib/service.mjs';
import { callTool, toolRegistry } from '../lib/tools.mjs';
import { createServer } from '../server.mjs';
import { documentImages } from '../lib/documents.mjs';
import { allowedPath } from '../lib/config.mjs';
import { seed, noSemantics } from './fixtures.mjs';
import { pdfWithPages } from '../../tests/helpers.mjs';

test('every extension agent tool is exposed by the standalone, with working file, item and announcement reads', async () => {
  const db = new CourseDatabase(':memory:'); const snapshot = seed(db);
  snapshot.data[0].announcements.push({ id: 3, title: 'Exam room', body: 'Use room 101.', postedAt: '2026-10-20T10:00:00Z', url: 'https://purdue.brightspace.com/news/3' });
  db.publish(snapshot, sourcesFromSnapshot(snapshot));
  db.savePages('file:101:7', db.source('file:101:7').revision, [{ label: 'page 1', text: 'Lecture objectives and radiation labels.' }]);
  const service = new CourseService(db, {}, { retrieval: noSemantics }); const registry = toolRegistry(service);
  try {
    for (const tool of AGENT_TOOLS) assert.ok(registry[tool.function.name], tool.function.name);
    const list = await callTool(registry, 'list_course_files', { course_id: 101 });
    assert.equal(list.files[0].file_key, 'content:7');
    const opened = await callTool(registry, 'read_course_file', { file_key: list.files[0].file_key, location: 'page 1' });
    assert.match(opened.excerpts[0].text, /radiation labels/);
    assert.ok(opened.sources.every(source => source.url.startsWith('https://purdue.brightspace.com/')));
    const items = await callTool(registry, 'list_items', { course_id: 101, when: 'all' });
    assert.equal(items.items.length, 1);
    const detail = await callTool(registry, 'get_item', { item_key: items.items[0].item_key, course_id: 101 });
    assert.match(detail.instructions, /orbit.txt/);
    const news = await callTool(registry, 'list_announcements', { course_id: 101 });
    assert.match(JSON.stringify(news), /room 101/);
  } finally { await service.close(); db.close(); }
});

test('the agent can save quote-verified syllabus facts, use its dates, and invalidate them when the source changes', async () => {
  const db = new CourseDatabase(':memory:'); const snapshot = seed(db);
  const id = 'file:101:7';
  db.savePages(id, db.source(id).revision, [{ label: 'page 1', text: 'AI may be used to study. The project is due November 10, 2026 at 6:00 PM.' }]);
  const service = new CourseService(db, {}, { retrieval: noSemantics }); const registry = toolRegistry(service);
  try {
    const saved = await callTool(registry, 'save_syllabus_facts', { course_id: 101, source_id: id, document_hash: db.source(id).contentHash, extraction: {
      deadlines: [{ title: 'Final project', kind: 'project', date: '2026-11-10', time: '18:00', quote: 'The project is due November 10, 2026 at 6:00 PM.' }],
      policies: { late_work: { summary: 'Unsupported', quote: 'Late work is always accepted.' }, ai_use: { stance: 'allowed', summary: 'Study help is allowed.', quote: 'AI may be used to study.' }, attendance: null, office_hours: null, grading: [] },
    } });
    assert.ok(saved.dropped.some(item => /late work/.test(item.what)));
    const facts = await callTool(registry, 'get_syllabus_facts', { course_id: 101 });
    assert.equal(facts.ai_use.stance, 'allowed');
    assert.equal(facts.syllabus_dates.length, 1);
    assert.match((await callTool(registry, 'list_courses')).courses[0].ai_policy, /allowed/);
    const upcoming = await callTool(registry, 'list_upcoming', { course_id: 101, days: 120 });
    assert.ok(upcoming.items.some(item => item.from_syllabus && item.title === 'Final project'));
    db.publish(snapshot, sourcesFromSnapshot(snapshot).map(source => source.id === id ? { ...source, revision: 'changed-revision' } : source));
    assert.equal((await callTool(registry, 'get_syllabus_facts', { course_id: 101 })).ai_use, undefined);
    assert.match((await callTool(registry, 'list_courses')).courses[0].ai_policy, /unknown/);
    db.savePages(id, db.source(id).revision, [{ label: 'page 1', text: 'A new syllabus revision.' }]);
    assert.equal((await callTool(registry, 'get_syllabus_facts', { course_id: 101 })).ai_use, undefined);
  } finally { await service.close(); db.close(); }
});

test('past quiz reads share the extension’s completion gate and exclude score and answer-key fields', async () => {
  const db = new CourseDatabase(':memory:'); const snapshot = seed(db);
  snapshot.data[0].quizzes = [{ id: 2, kind: 'quiz', courseId: 101, title: 'Past checkpoint', instructions: '', dueAt: '2026-10-01', url: 'https://purdue.brightspace.com/quiz/2' }];
  db.publish(snapshot, sourcesFromSnapshot(snapshot));
  const service = new CourseService(db, { client: async () => ({ getJson: async path => path.endsWith('/attempts/')
    ? [{ Completed: true, AttemptId: 8, Score: 'EXCLUDED_SCORE' }]
    : [{ Question: { QuestionInfo: { QuestionText: { Text: 'What is temporal locality?' }, Answers: [{ Answer: { Text: 'Recently reused data' }, IsCorrect: 'EXCLUDED_KEY' }] }, Score: 'EXCLUDED_SCORE' } }] }) }, { retrieval: noSemantics });
  try {
    assert.ok(allowedPath('/d2l/api/le/1.96/101/quizzes/2/attempts/8/questions/'));
    assert.ok(allowedPath('/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?qi=2&ou=101&ai=8'));
    assert.throws(() => allowedPath('/d2l/api/le/1.96/101/grades/values/myGradeValues/'), { code: 'blocked-request' });
    const quiz = await callTool(toolRegistry(service), 'read_quiz', { item_key: 'quiz:2' });
    assert.equal(quiz.questions.length, 1); assert.match(quiz.questions[0].text, /temporal locality/);
    assert.ok(!JSON.stringify(quiz).includes('EXCLUDED_'));
  } finally { await service.close(); db.close(); }
});

test('page pictures render locally and MCP sends actual image blocks instead of base64 in JSON', async () => {
  const picture = await documentImages({ bytes: pdfWithPages([['Figure caption']]), fileName: 'figure.pdf' }, 1);
  assert.equal(picture.images.length, 1);
  assert.equal(picture.images[0].mediaType, 'image/jpeg');
  assert.deepEqual([...Buffer.from(picture.images[0].data, 'base64').subarray(0, 2)], [255, 216]);
  const db = new CourseDatabase(':memory:'); seed(db);
  const service = new CourseService(db, {}, { retrieval: noSemantics }); service.agentTools = { run: async () => picture };
  const server = createServer(service); const client = new Client({ name: 'image-fixture', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({ name: 'read_course_file', arguments: { file_key: 'content:7', location: 'page 1', see_images: true } });
    assert.equal(result.content[1].type, 'image');
    assert.ok(!JSON.stringify(result.structuredContent).includes(picture.images[0].data));
  } finally { await client.close(); await server.close(); await service.close(); db.close(); }
});

test('a saved portal syllabus is reused locally and a failed explicit refresh retains its evidence', async () => {
  const db = new CourseDatabase(':memory:'); const snapshot = seed(db);
  const source = { id: 'file:101:syllabus-tab', courseId: 101, kind: 'file', title: 'Syllabus', url: 'https://purdue.brightspace.com/d2l/home/101', metadata: { fileKey: 'tab:101:lti', inline: true }, revision: 'synthetic-syllabus' };
  db.publish(snapshot, [...sourcesFromSnapshot(snapshot), source]);
  db.savePages(source.id, source.revision, [{ label: 'Syllabus', text: 'A complete saved syllabus.' }]);
  db.set('syllabus-source:101', { id: 'tab:101:lti', text: 'A complete saved syllabus.' });
  const service = new CourseService(db, { client: async () => { throw new Error('Synthetic offline service'); } }, { retrieval: noSemantics });
  try {
    const registry = toolRegistry(service);
    const result = await callTool(registry, 'discover_syllabus', { courseId: 101 });
    assert.equal(result.cached, true); assert.equal(result.sourceId, source.id);
    await assert.rejects(callTool(registry, 'discover_syllabus', { courseId: 101, refresh: true }), /Synthetic offline/);
    assert.equal(db.read(source.id, 1).text, 'A complete saved syllabus.');
    service.session.client = async () => ({ getJson: async () => [], getText: async () => '<nav>No syllabus</nav>' });
    service.syllabusBrowser = { links: async () => [] };
    assert.equal((await callTool(registry, 'discover_syllabus', { courseId: 101, refresh: true })).found, false);
    assert.equal(db.source(source.id), null);
  } finally { await service.close(); db.close(); }
});
