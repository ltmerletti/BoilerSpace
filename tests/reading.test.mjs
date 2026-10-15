import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask, createTools } from '../extension/lib/agent.js';
import { courseFiles, getCachedCourseFile, readCourseFile } from '../extension/lib/files.js';
import { locationUrl, syllabusFile, syllabusFileKey } from '../extension/lib/links.js';
import { installChrome, snapshotFixture } from './helpers.mjs';

function fixture(text = `${'Course resources and technology. '.repeat(100)}Midterm: in class, Thu Oct 22. There is no final exam. Make-ups are only for university-excused absences.`) {
  installChrome();
  const snapshot = snapshotFixture();
  snapshot.data[0].content = [];
  snapshot.data[0].overview = { fileUrl: '/d2l/api/le/1.96/1600001/overview/attachment' };
  const pages = [{ page: 3, label: 'page 3', text }];
  const syllabi = { 1600001: {
    courseId: 1600001, status: 'done', topicId: 'overview', title: 'Course overview attachment',
    kind: 'pdf', fileName: 'Course Syllabus.pdf', url: snapshot.courses[0].homeUrl, pages,
    policies: { lateWork: { summary: 'Make-ups require an excused absence.', quote: 'Make-ups are only for university-excused absences.', page: 'page 3' }, aiUse: {}, grading: [] },
    deadlines: [],
  } };
  return { snapshot, syllabi, pages };
}

const readCall = (args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_course_file', arguments: JSON.stringify({ file_key: 'overview:1600001', ...args }) } }] });

test('a full-page read includes the paragraph after the old 3000-character boundary', async () => {
  const env = fixture();
  assert.ok(env.pages[0].text.length > 3000);
  const tools = createTools(env);
  const result = await tools.run('read_course_file', { file_key: 'overview:1600001', location: 'page 3' });
  assert.equal(result.excerpts[0].text, env.pages[0].text);
  assert.equal(result.excerpts[0].complete_page, true);
  assert.equal(result.excerpts[0].truncated, false);
  assert.equal(result.excerpts[0].next_offset, undefined);
  assert.match(result.excerpts[0].text, /university-excused absences\.$/);
});

test('long pages have an explicit continuation that reconstructs the exact page', async () => {
  const text = `${'Full page material. '.repeat(1500)}The final sentence must not disappear.`;
  const tools = createTools(fixture(text));
  let offset = 0;
  let joined = '';
  const sourceIds = new Set();
  do {
    const result = await tools.run('read_course_file', { file_key: 'overview:1600001', location: 'page 3', offset });
    const excerpt = result.excerpts[0];
    assert.equal(excerpt.offset, offset);
    assert.equal(excerpt.total_chars, text.length);
    assert.ok(excerpt.text.length <= 12000);
    assert.equal(excerpt.truncated, excerpt.next_offset !== undefined);
    joined += excerpt.text;
    sourceIds.add(excerpt.source);
    offset = excerpt.next_offset;
  } while (offset !== undefined);
  assert.equal(joined, text);
  assert.equal(sourceIds.size, 1);
  assert.match((await tools.run('read_course_file', { file_key: 'overview:1600001', location: 'page 3', offset: -1 })).error, /offset/);
  assert.match((await tools.run('read_course_file', { file_key: 'overview:1600001', offset: 12000 })).error, /location/);
});

test('search, syllabus facts, and file reading share a page citation that opens the document', async () => {
  const tools = createTools(fixture());
  const found = await tools.run('search_course_material', { course_id: 1600001, query: 'midterm make-ups' });
  const source = found.results.find((r) => r.location === 'page 3').source;
  const facts = await tools.run('get_syllabus_facts', { course_id: 1600001 });
  const page = await tools.run('read_course_file', { file_key: 'overview:1600001', location: '3' });
  assert.equal(facts.late_work.source, source);
  assert.equal(page.excerpts[0].source, source);
  assert.equal(tools.sources.list.filter((s) => s.file_key === 'overview:1600001' && s.location === 'page 3').length, 1);
  const url = new URL(tools.sources.get(source).url);
  assert.ok(url.pathname.endsWith('/document.html'));
  assert.equal(url.searchParams.get('course'), '1600001');
  assert.equal(url.searchParams.get('file'), 'overview:1600001');
  assert.equal(url.hash, '#page=3');
});

test('overview reading reuses the saved syllabus without downloading it again', async () => {
  const env = fixture();
  const topic = courseFiles(env.snapshot, 1600001)[0];
  const loaded = await readCourseFile(topic, { syllabi: env.syllabi, download: () => assert.fail('the syllabus is already stored') });
  assert.equal(loaded.fileName, 'Course Syllabus.pdf');
  assert.equal(loaded.pages, env.pages);
  assert.equal((await getCachedCourseFile(topic, { syllabi: env.syllabi })).pages, env.pages);
});

test('an uploaded syllabus is not linked to a different overview attachment', () => {
  const env = fixture();
  const record = { ...env.syllabi[1600001], topicId: 'upload', source: 'upload', url: null };
  assert.equal(syllabusFileKey(record, env.snapshot), null);
  assert.equal(locationUrl(syllabusFile(record, env.snapshot), 'page 3'), null);
});

test('the agent reads the page before accepting an offer to read beyond an excerpt', async () => {
  let calls = 0;
  const result = await ask({ ...fixture(), question: 'What does the syllabus say about the midterm?', complete: async ({ messages }) => {
    calls++;
    if (calls === 1) return readCall({ query: 'midterm' });
    const read = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
    if (calls === 2) return { role: 'assistant', content: `The excerpt is cut off. If you want, I can pull the full page again [${read.excerpts[0].source}].` };
    assert.equal(read.excerpts[0].complete_page, true);
    assert.match(read.excerpts[0].text, /university-excused absences/);
    return { role: 'assistant', content: `Make-ups require a university-excused absence [${read.excerpts[0].source}].` };
  } });
  assert.equal(calls, 3);
  assert.equal(result.trace.filter((t) => t.type === 'tool').length, 2);
  assert.match(result.trace.at(-1).args.location, /page 3/);
  assert.match(result.text, /Make-ups require/);
  assert.doesNotMatch(result.text, /If you want|cut off/);
});

test('the agent follows a long-page continuation instead of rereading the same start', async () => {
  let calls = 0;
  const env = fixture(`${'Long document text. '.repeat(650)}End of the midterm instructions.`);
  const result = await ask({ ...env, question: 'Read the midterm instructions.', complete: async ({ messages }) => {
    calls++;
    if (calls === 1) return readCall({ location: 'page 3' });
    const read = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
    if (calls === 2) {
      assert.equal(read.excerpts[0].next_offset, 12000);
      return { role: 'assistant', content: 'The page is truncated. I can read the full page later.' };
    }
    assert.equal(read.excerpts[0].offset, 12000);
    assert.match(read.excerpts[0].text, /End of the midterm instructions\.$/);
    return { role: 'assistant', content: `The instructions were read [${read.excerpts[0].source}].` };
  } });
  assert.equal(result.trace.at(-1).args.offset, 12000);
  assert.equal(result.citations.length, 1);
});
