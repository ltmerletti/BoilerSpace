import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFixture, SYLLABUS_PAGES } from './helpers.mjs';
import { buildIndex, documentsFromSnapshot, search, tokenize } from '../extension/lib/search.js';
import { ask, createTools, partialAnswer, resolveCitations, summarizeResult, thinkingText } from '../extension/lib/agent.js';
import { readEventStream } from '../extension/lib/genai.js';
import { locationUrl } from '../extension/lib/links.js';

const NOW = new Date('2026-10-13T16:00:00Z');
const SYLLABI = {
  1600001: {
    status: 'done',
    courseId: 1600001,
    title: 'CS 25200 Syllabus Fall 2026.pdf',
    url: 'https://purdue.brightspace.com/c/77',
    pages: SYLLABUS_PAGES,
    deadlines: [{ id: 'syl-1600001-x', courseId: 1600001, title: 'Final project demo', kind: 'presentation', date: '2026-12-04', time: null, dueAt: null, quote: 'Final project demo: Friday, December 4 (in lab)', page: 'page 3', matchedItem: null, dateDiffers: false }],
    policies: {
      lateWork: { summary: 'Up to 2 days late, 10% off per day.', quote: 'Each project may be submitted up to 2 days late with a 10% penalty per day.', page: 'page 2' },
      attendance: null,
      officeHours: null,
      aiUse: { stance: 'restricted', summary: 'No AI-written code.', quote: 'you may not submit any code written by an AI tool', page: 'page 2' },
      grading: [],
      gradingAddsUp: true,
    },
  },
};

test('search finds the late policy in the syllabus and the room change announcement', () => {
  const index = buildIndex(documentsFromSnapshot(snapshotFixture(), SYLLABI));
  const late = search(index, 'what is the late penalty for projects?');
  assert.equal(late[0].kind, 'syllabus');
  assert.match(late[0].label, /CS 25200 syllabus, page 2/);
  const room = search(index, 'midterm room');
  assert.ok(room.some((r) => r.kind === 'announcement'));
  assert.deepEqual(search(index, 'zebra'), []);
  assert.deepEqual(tokenize('The Projects are due'), ['project', 'due']);
});

test('tools give exact dates, resolve course labels and never include grades', async () => {
  const tools = createTools({ snapshot: snapshotFixture(), syllabi: SYLLABI, now: NOW });
  const upcoming = await tools.run('list_upcoming', { course_id: 'CS 25200', days: 60 });
  assert.equal(upcoming[0].title, 'Quiz 5');
  assert.equal(upcoming[0].days_from_today, 1);
  assert.match(upcoming[0].due_display, /^Wed, Oct 14, 2026, 11:00\sAM ET$/);
  const demo = upcoming.find((u) => u.title === 'Final project demo');
  assert.equal(demo.from_syllabus, true);
  assert.equal(demo.due_display, 'Fri, Dec 4, 2026 (all day)');

  const courses = await tools.run('list_courses', {});
  assert.deepEqual(courses.map((c) => c.label), ['CS 25200', 'MA 26500'], 'past enrollments are left out');
  assert.equal(courses[0].ai_policy, 'restricted');

  const detail = await tools.run('get_item', { item_key: 'assignment:11' });
  assert.match(detail.instructions, /Unix shell/);
  assert.match((await tools.run('get_item', { item_key: 'assignment:999' })).error, /No assignment/);
  assert.match((await tools.run('list_upcoming', { course_id: 'CHEM 11500' })).error, /No current course/);

  const everything = JSON.stringify([upcoming, courses, detail, await tools.run('get_syllabus_facts', { course_id: 1600001 }), await tools.run('list_announcements', {})]);
  assert.ok(!everything.includes('9 / 10'));
});

test('course files can be listed and opened, with passages matched to the question', async () => {
  const snapshot = snapshotFixture();
  const opened = [];
  const readFile = async (topic) => {
    opened.push(topic.title);
    return { pages: [{ page: 1, label: 'page 1', text: 'Welcome to the course.' }, { page: 2, label: 'page 2', text: 'Midterm exam: Wednesday, October 21, 7:00 PM in EE 129.' }] };
  };
  const tools = createTools({ snapshot, syllabi: {}, now: NOW, readFile });
  const facts = await tools.run('get_syllabus_facts', { course_id: 1600001 });
  assert.match(facts.note, /list_course_files/);

  const listing = await tools.run('list_course_files', { course_id: 1600001, query: 'syllabus' });
  const syllabus = listing.files.find((f) => /syllabus/i.test(f.title));
  assert.ok(syllabus?.can_open, 'the syllabus file is listed and can be opened');

  const read = await tools.run('read_course_file', { file_key: syllabus.file_key, query: 'when is the midterm' });
  assert.deepEqual(opened, [syllabus.title]);
  assert.equal(read.excerpts[0].location, 'page 2');
  assert.match(read.excerpts[0].text, /October 21/);
  assert.match(read.excerpts[0].source, /^S\d+$/);
  assert.deepEqual(tools.stepLabels('read_course_file', { file_key: syllabus.file_key }), [`Opening ${syllabus.title}`, `Opened ${syllabus.title}`]);
  assert.match((await tools.run('read_course_file', { file_key: 'content:424242' })).error, /No course file/);
});

test('citations keep only ids the tools handed out', async () => {
  const tools = createTools({ snapshot: snapshotFixture(), syllabi: SYLLABI, now: NOW });
  await tools.run('list_upcoming', {});
  const { text, citations } = resolveCitations('Quiz 5 is tomorrow [S1]. Project 1 is Thursday [S2, S40]. Made up [S99].', tools.sources);
  assert.equal(text, 'Quiz 5 is tomorrow [S1]. Project 1 is Thursday [S2]. Made up.');
  assert.deepEqual(citations.map((c) => c.id), ['S1', 'S2']);
});

test('the agent loop calls tools, passes results back and returns cited sources', async () => {
  const calls = [];
  async function complete(body) {
    calls.push(structuredClone(body));
    if (calls.length === 1) {
      return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_upcoming', arguments: '{"days":7}' } }] };
    }
    const toolResult = JSON.parse(body.messages.at(-1).content);
    const quiz = toolResult.find((r) => r.title === 'Quiz 5');
    return { role: 'assistant', content: `You have Quiz 5 on ${quiz.due_display} [${quiz.source}].` };
  }
  const traces = [];
  const answer = await ask({ question: 'What is due this week?', snapshot: snapshotFixture(), syllabi: SYLLABI, reviews: {}, now: NOW, complete, onTrace: (trace) => traces.push(trace) });

  assert.deepEqual(traces[0], [{ type: 'tool', name: 'list_upcoming', args: { days: 7 }, label: 'Checking what is due', active: true, summary: null }], 'a running tool shows up before it finishes');
  assert.deepEqual(answer.trace, [{ type: 'tool', name: 'list_upcoming', args: { days: 7 }, label: 'Checked what is due', active: false, summary: '2 items' }]);
  assert.deepEqual(answer.steps, ['Checked what is due']);
  assert.equal(calls.length, 2);
  assert.match(calls[0].messages[0].content, /Today is Tuesday, October 13, 2026/);
  assert.match(calls[0].messages[0].content, /CS 25200 \(course_id 1600001\): AI policy restricted/);
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.match(answer.text, /Quiz 5 on Wed, Oct 14, 2026/);
  assert.equal(answer.citations.length, 1);
  assert.equal(answer.citations[0].url, 'https://purdue.brightspace.com/q/21');
});

test('the agent stops calling tools after the turn limit', async () => {
  let count = 0;
  const complete = async (body) => {
    count++;
    if (body.tool_choice === 'none') return { role: 'assistant', content: 'Here is what I found.' };
    return { role: 'assistant', content: null, tool_calls: [{ id: `c${count}`, type: 'function', function: { name: 'list_courses', arguments: '{}' } }] };
  };
  const answer = await ask({ question: 'loop', snapshot: snapshotFixture(), syllabi: {}, reviews: {}, now: NOW, complete });
  assert.equal(count, 8);
  assert.equal(answer.text, 'Here is what I found.');
});

test('a model that runs out of lookups is told to answer, and says what it checked if it still cannot', async () => {
  const last = [];
  const complete = async (body) => {
    if (body.tool_choice === 'none') {
      last.push(body.messages.at(-1));
      return { role: 'assistant', content: '<think>Still not sure.</think>' };
    }
    return { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'list_courses', arguments: '{}' } }] };
  };
  const answer = await ask({ question: 'loop', snapshot: snapshotFixture(), syllabi: {}, reviews: {}, now: NOW, complete });
  assert.equal(last.length, 1);
  assert.equal(last[0].role, 'user');
  assert.match(last[0].content, /answer my question now/);
  assert.equal(answer.text, "I couldn't put an answer together. I checked: Checked your courses. Try asking a narrower question.");
});

test('an answer that is only reasoning gets one more turn to say something', async () => {
  const choices = [];
  const complete = async (body) => {
    choices.push(body.tool_choice);
    return choices.length === 1 ? { role: 'assistant', content: '<think>The handout has no time estimates.</think>' } : { role: 'assistant', content: 'The handout does not give time estimates.' };
  };
  const answer = await ask({ question: 'How long is each part?', snapshot: snapshotFixture(), syllabi: {}, reviews: {}, now: NOW, complete });
  assert.deepEqual(choices, ['auto', 'none']);
  assert.equal(answer.text, 'The handout does not give time estimates.');
  assert.equal(summarizeResult('search_course_material', { results: [1, 2, 3, 4, 5] }), '5 matches');
});

test('streamed answers and tool calls are put back together', async () => {
  const events = [
    { choices: [{ delta: { role: 'assistant', content: 'Quiz 5 is ' } }] },
    { choices: [{ delta: { content: 'tomorrow [S1' } }] },
    { choices: [{ delta: { content: '].' } }] },
  ];
  const body = (list) =>
    new ReadableStream({
      start(controller) {
        const text = list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
        // Split mid-line to check buffering.
        controller.enqueue(new TextEncoder().encode(text.slice(0, 37)));
        controller.enqueue(new TextEncoder().encode(text.slice(37)));
        controller.close();
      },
    });
  const seen = [];
  const message = await readEventStream(body(events), (text) => seen.push(partialAnswer(text)));
  assert.equal(message.content, 'Quiz 5 is tomorrow [S1].');
  assert.equal(seen.at(-1), 'Quiz 5 is tomorrow.');
  assert.equal(seen[1], 'Quiz 5 is tomorrow', 'a half-written citation is hidden');

  const toolMessage = await readEventStream(
    body([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'list_upcoming', arguments: '{"da' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ys":7}' } }] } }] },
    ]),
  );
  assert.deepEqual(toolMessage.tool_calls, [{ id: 'call_a', type: 'function', function: { name: 'list_upcoming', arguments: '{"days":7}' } }]);
  assert.equal(partialAnswer('<think>hmm</think>Hello'), 'Hello');
  assert.equal(partialAnswer('<think>still thinking'), '');

  const reasoned = [];
  const withReasoning = await readEventStream(
    body([
      { choices: [{ delta: { reasoning_content: 'The student wants ' } }] },
      { choices: [{ delta: { reasoning_content: 'this week.' } }] },
      { choices: [{ delta: { content: 'Done.' } }] },
    ]),
    (content, reasoning) => reasoned.push([content, reasoning]),
  );
  assert.equal(withReasoning.reasoning, 'The student wants this week.');
  assert.deepEqual(reasoned[1], ['', 'The student wants this week.'], 'reasoning streams before any answer text');
  assert.equal(thinkingText('<think>Check the syllabus first', ''), 'Check the syllabus first');
});

test('a stream that goes quiet fails instead of hanging', async () => {
  const silent = new ReadableStream({ start() {} });
  await assert.rejects(readEventStream(silent, () => {}, { idleMs: 30 }), /stopped responding/);
});

test('the work log keeps the reasoning of each turn next to the tools it led to', async () => {
  let turn = 0;
  async function complete(body, { onDelta }) {
    turn++;
    if (turn === 1) {
      onDelta('<think>Look in the syllabus', '');
      return { role: 'assistant', content: '<think>Look in the syllabus</think>', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_course_files', arguments: '{"course_id":1600001}' } }] };
    }
    onDelta('', 'Found it.');
    return { role: 'assistant', content: 'It is in the syllabus.', reasoning: 'Found it.' };
  }
  const answer = await ask({ question: 'Where is the syllabus?', snapshot: snapshotFixture(), syllabi: {}, reviews: {}, now: NOW, complete, onText: () => {} });
  assert.deepEqual(
    answer.trace.map((e) => (e.type === 'thought' ? `thought: ${e.text}` : `tool: ${e.name}, ${e.summary}`)),
    ['thought: Look in the syllabus', 'tool: list_course_files, 2 files', 'thought: Found it.'],
  );
  assert.equal(answer.text, 'It is in the syllabus.');
  assert.equal(summarizeResult('read_course_file', { error: 'File not found' }), 'Failed: File not found');
});

test('PDF passages link to their page in the file; other files link to their Brightspace page', async () => {
  const snapshot = snapshotFixture();
  snapshot.data[0].content[0].fileHref = '/content/enforced/1600001-CS25200/Syllabus.pdf';
  const readFile = async () => ({ kind: 'pdf', pages: [{ page: 3, label: 'page 3', text: 'Midterm exam: October 21.' }] });
  const tools = createTools({ snapshot, syllabi: {}, now: NOW, readFile });
  const read = await tools.run('read_course_file', { file_key: 'content:77', query: 'midterm' });
  assert.equal(tools.sources.get(read.excerpts[0].source).url, 'https://purdue.brightspace.com/content/enforced/1600001-CS25200/Syllabus.pdf#page=3');
  assert.equal(locationUrl({ url: 'https://purdue.brightspace.com/c/78', fileHref: '/content/enforced/x/notes.docx', kind: 'docx' }, 'part 2'), 'https://purdue.brightspace.com/c/78');
  assert.equal(locationUrl({ url: 'https://purdue.brightspace.com/c/77', fileHref: null, kind: 'pdf' }, 'page 2'), 'https://purdue.brightspace.com/c/77');
});

test('read_course_file finds a passage deep in a long file, outlines it once, and reads a page by location', async () => {
  const filler = (n) => `Week ${n} covers routine review material and practice problems for the unit. `.repeat(12);
  const pages = Array.from({ length: 18 }, (_, i) => ({ page: i + 1, label: `page ${i + 1}`, text: filler(i + 1) }));
  pages[14].text += 'Late submissions lose ten percent per day and close after two days.';
  const tools = createTools({ snapshot: snapshotFixture(), syllabi: {}, now: NOW, readFile: async () => ({ kind: 'pdf', pages }) });

  const first = await tools.run('read_course_file', { file_key: 'content:77', query: 'late submissions penalty' });
  assert.equal(first.excerpts[0].location, 'page 15');
  assert.match(first.excerpts[0].text, /ten percent per day/);
  assert.ok(first.excerpts.reduce((n, e) => n + e.text.length, 0) <= 3600 + 1000, 'excerpts stay within the budget');
  assert.equal(first.outline.length, 18);
  assert.match(first.outline[2], /^page 3: Week 3 covers/);

  const again = await tools.run('read_course_file', { file_key: 'content:77', query: 'practice problems' });
  assert.equal(again.outline, undefined, 'the outline is only sent the first time');

  const page = await tools.run('read_course_file', { file_key: 'content:77', location: 'page 15' });
  assert.equal(page.excerpts.length, 1);
  assert.match(page.excerpts[0].text, /close after two days/);
  assert.equal((await tools.run('read_course_file', { file_key: 'content:77', location: '3' })).excerpts[0].location, 'page 3');
  assert.match((await tools.run('read_course_file', { file_key: 'content:77', location: 'slide 40' })).error, /page 1 to page 18/);
});

test('search_course_material indexes readable course files and quiz metadata, get_item matches titles, and failed files report non-substitution guidance', async () => {
  const snapshot = snapshotFixture();
  const opened = new Map();
  const readFile = async (topic) => {
    if (topic.id === 78) throw new Error('File is larger than 25 MB.');
    const file = { kind: 'pdf', pages: [{ page: 1, label: 'page 1', text: 'Each pair submits one zebra worksheet.' }] };
    opened.set(topic.id, file);
    return file;
  };
  const cachedFile = (topic) => (opened.has(topic.id) ? Promise.resolve(opened.get(topic.id)) : null);
  const tools = createTools({ snapshot, syllabi: {}, now: NOW, readFile, cachedFile });

  const before = await tools.run('search_course_material', { query: 'zebra worksheet' });
  assert.ok(!before.results.some((r) => r.file_key === 'content:77'), 'unopened files are not searched');
  await tools.run('read_course_file', { file_key: 'content:77', query: 'pairs' });
  const searchRes = await tools.run('search_course_material', { query: 'zebra worksheet' });
  assert.ok(searchRes.results.some((r) => r.file_key === 'content:77' && r.snippet.includes('zebra worksheet')));

  const quizSearch = await tools.run('search_course_material', { query: 'Quiz 5' });
  const quizHit = quizSearch.results.find((r) => r.item_key === 'quiz:21');
  assert.ok(quizHit, 'quiz search includes item_key');
  assert.match(quizHit.snippet, /Time limit: 20 minutes/);
  assert.match(quizHit.snippet, /Attempts allowed: 1/);

  const byTitle = await tools.run('get_item', { item_key: 'Quiz 5' });
  assert.equal(byTitle.item_key, 'quiz:21');
  assert.equal(byTitle.attempts_allowed, 1);
  assert.equal((await tools.run('get_item', { item_key: 'quiz:5' })).item_key, 'quiz:21', 'a quiz number given as an id falls back to the title');

  const failed = await tools.run('read_course_file', { file_key: 'content:78', query: 'slide 12' });
  assert.match(failed.error, /25 MB/);
  assert.match(failed.note, /do not substitute another file/);
});
