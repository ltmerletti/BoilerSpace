import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFixture, SYLLABUS_PAGES } from './helpers.mjs';
import { buildIndex, documentsFromSnapshot, search, tokenize } from '../extension/lib/search.js';
import { ask, createTools, partialAnswer, resolveCitations, stripStaleCitations, summarizeResult, thinkingText, toolMessageContent, toolPreview } from '../extension/lib/agent.js';
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
  assert.equal(late[0].file_key, 'content:77');
  assert.match(late[0].label, /CS 25200 syllabus, page 2/);
  const room = search(index, 'midterm room');
  assert.ok(room.some((r) => r.kind === 'announcement'));
  assert.deepEqual(search(index, 'zebra'), []);
  assert.deepEqual(tokenize('The Projects are due'), ['project', 'due']);
});

test('tools give exact dates, resolve course labels and never include grades', async () => {
  const tools = createTools({ snapshot: snapshotFixture(), syllabi: SYLLABI, now: NOW });
  const upcoming = (await tools.run('list_upcoming', { course_id: 'CS 25200', days: 60 })).items;
  assert.equal(upcoming[0].title, 'Quiz 5');
  assert.equal(upcoming[0].assessment, undefined, 'a quiz is not marked as an assessment');
  assert.equal(upcoming.find((u) => u.title === 'Midterm 1').assessment, true, 'an event titled like an exam is marked as an assessment');
  assert.equal(upcoming[0].days_from_today, 1);
  assert.match(upcoming[0].due_display, /^Wed, Oct 14, 2026, 11:00\sAM ET$/);
  const demo = upcoming.find((u) => u.title === 'Final project demo');
  assert.equal(demo.from_syllabus, true);
  assert.equal(demo.due_display, 'Fri, Dec 4, 2026 (all day)');

  const courses = await tools.run('list_courses', {});
  assert.deepEqual(courses.map((c) => c.label), ['CS 25200', 'MA 26500'], 'past enrollments are left out');
  assert.equal(courses[0].ai_policy, 'restricted. No AI-written code.');

  const detail = await tools.run('get_item', { item_key: 'assignment:11' });
  assert.match(detail.instructions, /Unix shell/);
  assert.match((await tools.run('get_item', { item_key: 'assignment:999' })).error, /No assignment/);
  assert.match((await tools.run('list_upcoming', { course_id: 'CHEM 11500' })).error, /No current course/);

  const everything = JSON.stringify([upcoming, courses, detail, await tools.run('get_syllabus_facts', { course_id: 1600001 }), await tools.run('list_announcements', {})]);
  assert.ok(!everything.includes('9 / 10'));
});

test('list_items returns quizzes and assignments that are already due', async () => {
  const snapshot = snapshotFixture();
  snapshot.data[0].quizzes.push({ kind: 'quiz', id: 20, courseId: 1600001, title: 'Quiz 4', dueAt: '2026-10-01T15:00:00.000Z', instructions: 'Covers pipes and files.', timeLimitMinutes: 15, attempts: 1, url: 'https://purdue.brightspace.com/q/20' });
  const tools = createTools({ snapshot, syllabi: {}, now: NOW });
  const past = await tools.run('list_items', { course_id: 1600001, when: 'past' });
  assert.deepEqual(past.items.map((item) => item.title), ['Quiz 4']);
  assert.equal(past.items[0].item_key, 'quiz:20');
  assert.equal(past.items[0].days_from_today < 0, true);
  assert.match(past.items[0].instructions, /pipes and files/);
  const upcoming = await tools.run('list_upcoming', { course_id: 1600001, days: 60 });
  assert.equal(upcoming.items.some((item) => item.title === 'Quiz 4'), false);
  const quizzes = await tools.run('list_items', { course_id: 1600001, kind: 'quiz', when: 'all' });
  assert.deepEqual(quizzes.items.map((item) => item.title), ['Quiz 5', 'Quiz 4']);
  assert.equal(JSON.stringify(past).includes('9 / 10'), false);
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

test('a syllabus page can be opened with the file key from search, or as syllabus', async () => {
  const snapshot = snapshotFixture();
  snapshot.data[0].overview = { text: '', hasAttachment: true, fileUrl: '/d2l/api/le/1.96/1600001/overview/attachment' };
  const syllabi = {
    1600001: { status: 'done', courseId: 1600001, topicId: 'overview', title: 'Course overview attachment', pages: [{ page: 3, label: 'page 3', text: 'Midterm in class Thu Oct 22, covering Module 1.' }], policies: { lateWork: null, attendance: null, officeHours: null, aiUse: {}, grading: [] }, deadlines: [] },
  };
  const opened = [];
  const readFile = async (topic) => {
    opened.push(topic.key);
    return { pages: [{ page: 3, label: 'page 3', text: 'Midterm in class Thu Oct 22, covering Module 1.' }] };
  };
  const tools = createTools({ snapshot, syllabi, now: NOW, readFile });
  const found = search(buildIndex(documentsFromSnapshot(snapshot, syllabi)), 'midterm module', { courseId: 1600001 });
  assert.equal(found[0].file_key, 'overview:1600001');
  const facts = await tools.run('get_syllabus_facts', { course_id: 1600001 });
  assert.equal(facts.file_key, 'overview:1600001');
  const listed = await tools.run('list_course_files', { course_id: 1600001, query: 'syllabus' });
  assert.equal(listed.files.some((f) => f.file_key === 'overview:1600001'), true);
  const read = await tools.run('read_course_file', { file_key: 'syllabus', location: 'page 3' });
  assert.equal(read.excerpts[0].location, 'page 3');
  assert.deepEqual(opened, ['overview:1600001']);
});

test('citations keep only ids the tools handed out', async () => {
  const tools = createTools({ snapshot: snapshotFixture(), syllabi: SYLLABI, now: NOW });
  await tools.run('list_upcoming', {});
  const { text, citations } = resolveCitations('Quiz 5 is tomorrow [S1]. Project 1 is Thursday [S2, S40]. Made up [S99].', tools.sources);
  assert.equal(text, 'Quiz 5 is tomorrow [1]. Project 1 is Thursday [2]. Made up.');
  assert.deepEqual(citations.map((c) => c.id), ['S1', 'S2']);
  assert.equal(stripStaleCitations('The midterm is Thursday [S2]. See [1, 2]. Year [2026] stays.'), 'The midterm is Thursday. See. Year [2026] stays.');
});

test('the agent loop calls tools, passes results back and returns cited sources', async () => {
  const calls = [];
  async function complete(body) {
    calls.push(structuredClone(body));
    if (calls.length === 1) {
      return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_upcoming', arguments: '{"days":7}' } }] };
    }
    const toolResult = JSON.parse(body.messages.at(-1).content);
    const quiz = toolResult.items.find((r) => r.title === 'Quiz 5');
    return { role: 'assistant', content: `You have Quiz 5 on ${quiz.due_display} [${quiz.source}].` };
  }
  const traces = [];
  const answer = await ask({ question: 'What is due this week?', snapshot: snapshotFixture(), syllabi: SYLLABI, reviews: {}, now: NOW, complete, onTrace: (trace) => traces.push(trace) });

  assert.deepEqual(traces[0], [{ type: 'tool', name: 'list_upcoming', args: { days: 7 }, label: 'Checking what is due', active: true, summary: null }], 'a running tool shows up before it finishes');
  assert.deepEqual(answer.trace.map(({ details, ...step }) => step), [{ type: 'tool', name: 'list_upcoming', args: { days: 7 }, label: 'Checked what is due', active: false, summary: '2 items' }]);
  assert.ok(answer.trace[0].details.some(item => item.text.includes('Quiz 5')));
  assert.deepEqual(answer.steps, ['Checked what is due']);
  assert.equal(calls.length, 2);
  assert.match(calls[0].messages[0].content, /Today is Tuesday, October 13, 2026/);
  assert.match(calls[0].messages[0].content, /CS 25200 \(course_id 1600001\): AI policy restricted\. No AI-written code\./);
  assert.match(calls[0].messages[0].content, /restricted AI policy limits how work may be submitted/);
  assert.match(calls[0].messages[0].content, /open the lecture files that scope names/);
  assert.match(calls[0].messages[0].content, /applies while that exam is being taken/);
  assert.match(calls[0].messages[0].content, /Call list_items/);
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
  assert.equal(count, 12);
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

test('a reworded search is refused, and citation markers from an earlier reply are not sent back to the model', async () => {
  const tools = createTools({ snapshot: snapshotFixture(), syllabi: SYLLABI, now: NOW });
  const first = await tools.run('search_course_material', { query: 'late penalty', course_id: 1600001 });
  assert.ok(first.results.length > 0);
  const again = await tools.run('search_course_material', { query: 'late penalty for work', course_id: 1600001 });
  assert.match(again.note, /already searched/);
  assert.equal(again.results, undefined);
  const broader = await tools.run('search_course_material', { query: 'penalty', course_id: 1600001 });
  assert.ok(broader.results?.length, 'a broader search is allowed');

  let seen = '';
  await ask({
    question: 'And the room?',
    history: [
      { role: 'user', content: 'When is the midterm?' },
      { role: 'assistant', content: 'The midterm is Wednesday [S2].' },
    ],
    snapshot: snapshotFixture(),
    syllabi: SYLLABI,
    now: NOW,
    complete: async (body) => {
      seen = body.messages.find((m) => m.role === 'assistant')?.content ?? '';
      return { role: 'assistant', content: 'ELLT 116 [S1].' };
    },
  });
  assert.equal(seen, 'The midterm is Wednesday.');
});

test('a reply with no lookup is sent back to look the course up, and a PDF is listed instead of the same PowerPoint', async () => {
  let calls = 0;
  let followup = '';
  const answer = await ask({
    question: 'What is a multiplexer?',
    snapshot: snapshotFixture(),
    syllabi: SYLLABI,
    now: NOW,
    complete: async (body) => {
      calls += 1;
      followup = body.messages.at(-1).content;
      return { role: 'assistant', content: 'It selects one input.' };
    },
  });
  assert.equal(calls, 2);
  assert.match(followup, /Look this up/);
  assert.match(answer.text, /selects one input/);

  const snapshot = snapshotFixture();
  snapshot.data[0].content.push({ id: 79, courseId: 1600001, title: 'Lecture 12 slides.pptx', modulePath: ['Week 7'], type: 'File', fileUrl: '/d2l/api/le/1.96/1600001/content/topics/79/file', url: 'https://purdue.brightspace.com/c/79', isHidden: false });
  const titles = (await createTools({ snapshot, syllabi: {}, now: NOW }).run('list_course_files', { course_id: 1600001 })).files.map((f) => f.title);
  assert.ok(titles.includes('Lecture 12 slides.pdf'));
  assert.ok(!titles.includes('Lecture 12 slides.pptx'));
});

test('duplicate attachment titles prefer the PDF link even when the title has no extension', async () => {
  const snapshot = snapshotFixture();
  const topic = snapshot.data[0].content[1];
  snapshot.data[0].content = ['rtf', 'pptx', 'pdf'].map((ext, index) => ({ ...topic, id: 700 + index, title: 'Week 07 slides', fileHref: `/content/enforced/course/Week%2007%20slides.${ext}?download=1` }));
  const tools = createTools({ snapshot, syllabi: {}, now: NOW });
  const files = await tools.run('list_course_files', { course_id: 1600001, query: 'Week 07' });
  assert.equal(files.total, 1);
  assert.equal(files.files[0].file_key, 'content:702');
  snapshot.data[0].content.push({ ...topic, id: 703, title: 'Week 07 slides', modulePath: ['Supplemental notes'], fileHref: '/content/enforced/course/other.rtf' });
  const separate = await createTools({ snapshot, syllabi: {}, now: NOW }).run('list_course_files', { course_id: 1600001, query: 'Week 07' });
  assert.deepEqual(separate.files.map(file => file.file_key), ['content:702', 'content:703']);
});

test('an RTF-only lecture can be opened, searched and cited without substituting another file', async () => {
  const { readCourseFile, getCachedCourseFile } = await import('../extension/lib/files.js');
  const { RTF_LECTURE } = await import('./rtf-fixture.mjs');
  const snapshot = snapshotFixture();
  const topic = snapshot.data[0].content[1];
  topic.id = 707;
  topic.title = 'Week 07 slides.rtf';
  const downloads = [];
  const readFile = (file, options) => readCourseFile(file, { ...options, download: async path => {
    downloads.push(path);
    return { bytes: new TextEncoder().encode(RTF_LECTURE), fileName: 'Week 07 slides.rtf', contentType: 'application/rtf' };
  } });
  const tools = createTools({ snapshot, syllabi: {}, now: NOW, readFile, cachedFile: getCachedCourseFile });
  const result = await tools.run('read_course_file', { file_key: 'content:707', query: 'fraction exponent' });
  assert.match(result.excerpts[0].text, /23-bit fraction and an exponent bias of 127/);
  assert.equal(result.excerpts[0].file_key, 'content:707');
  assert.equal(result.excerpts[0].location, 'part 1');
  assert.equal(tools.sources.get(result.excerpts[0].source).url, topic.url);
  const full = await tools.run('read_course_file', { file_key: 'content:707', location: 'part 1' });
  assert.equal(full.excerpts[0].complete_page, true);
  assert.equal(downloads.length, 1, 'the extracted text is reused for follow-up reads');
  const search = await tools.run('search_course_material', { course_id: 1600001, query: 'fraction exponent' });
  assert.ok(search.results.some(hit => hit.file_key === 'content:707'));
});

test('read_quiz reports the questions and does not pass a score through', async () => {
  const snapshot = snapshotFixture();
  const tools = createTools({
    snapshot,
    syllabi: {},
    now: NOW,
    readQuiz: async () => ({ questions: [{ number: 1, text: 'What does fork return?' }], score: 8, note: undefined }),
  });
  const result = await tools.run('read_quiz', { item_key: 'quiz:21' });
  assert.equal(result.title, 'Quiz 5');
  assert.equal(result.questions[0].text, 'What does fork return?');
  assert.equal(JSON.stringify(result).includes('score'), false);
  assert.equal(tools.stepLabels('read_quiz', { item_key: 'quiz:21' })[0], 'Reading Quiz 5');
});

test('a picture is attached for the model to see and left out of the tool text', async () => {
  const seen = [];
  const readFile = async (_topic, options) => {
    const pages = [{ page: 4, label: 'slide 4', text: 'Diagram of the energy budget.' }];
    if (options?.seeImages) return { kind: 'pptx', pages, images: [{ mediaType: 'image/jpeg', data: 'abc' }] };
    return { kind: 'pptx', pages };
  };
  const answer = await ask({
    question: 'What does the figure on slide 4 show?',
    snapshot: snapshotFixture(),
    syllabi: {},
    now: NOW,
    readFile,
    complete: async (body) => {
      seen.push(body.messages.at(-1));
      const call = body.messages.find((message) => message.role === 'tool');
      if (!call) {
        return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_course_file', arguments: '{"file_key":"content:77","location":"slide 4","see_images":true}' } }] };
      }
      return { role: 'assistant', content: 'The figure shows the energy budget.' };
    },
  });
  const content = seen.at(-1).content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content.some((part) => part.type === 'image_url' && part.image_url.url === 'data:image/jpeg;base64,abc'), true);
  assert.equal(content.find((part) => part.type === 'text').text.includes('abc'), false);
  assert.match(answer.text, /energy budget/);
  const packed = toolMessageContent({ title: 'Deck', images: [{ mediaType: 'image/png', data: 'zzz' }] });
  assert.equal(packed.find((part) => part.type === 'text').text.includes('zzz'), false);
});

test('an exam-contents reply that never opened a lecture is sent back to open one', async () => {
  const followups = [];
  let calls = 0;
  const answer = await ask({
    question: 'What are the exact contents of the upcoming exam?',
    snapshot: snapshotFixture(),
    syllabi: SYLLABI,
    now: NOW,
    complete: async (body) => {
      calls += 1;
      followups.push(body.messages.at(-1).content);
      if (calls === 1) {
        return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_course_file', arguments: '{"file_key":"overview:1600001","query":"exam"}' } }] };
      }
      if (calls === 2) return { role: 'assistant', content: 'It covers chapters 1 to 8. I can pull the learning goals if you want.' };
      return { role: 'assistant', content: 'The lecture states these objectives.' };
    },
  });
  assert.match(followups.at(-1), /Open the lecture files/);
  assert.match(answer.text, /objectives/);

  calls = 0;
  await ask({
    question: 'What are the exact contents of the upcoming exam?',
    snapshot: snapshotFixture(),
    syllabi: SYLLABI,
    now: NOW,
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_course_file', arguments: '{"file_key":"content:77","query":"objectives"}' } }] };
      }
      return { role: 'assistant', content: 'The lecture states these objectives.' };
    },
  });
  assert.equal(calls, 2, 'opening a lecture file is enough to answer');
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


test('assistant commentary stays ordered before its tool calls and separate from the final answer', async () => {
  let turn = 0;
  const answer = await ask({ question: 'What is due?', snapshot: snapshotFixture(), syllabi: {}, now: NOW, requestParams: { reasoning_effort: 'low' }, complete: async body => {
    assert.equal(body.reasoning_effort, 'low');
    if (!turn++) return { role: 'assistant', content: 'I will check the upcoming assignments.', tool_calls: [{ id: 'due', type: 'function', function: { name: 'list_upcoming', arguments: '{"days":7}' } }] };
    return { role: 'assistant', content: 'Quiz 5 is coming up.' };
  } });
  assert.equal(answer.trace[0].type, 'commentary');
  assert.equal(answer.trace[0].text, 'I will check the upcoming assignments.');
  assert.equal(answer.trace[1].name, 'list_upcoming');
  assert.equal(answer.text, 'Quiz 5 is coming up.');
});

test('narration from a separate assistant turn survives the lookup follow-up and later tools', async () => {
  const narration = 'I will check the posted deadlines first.';
  let turn = 0;
  const observed = [];
  const answer = await ask({ question: 'What is due?', snapshot: snapshotFixture(), syllabi: {}, now: NOW,
    onTrace: trace => observed.push(trace), onText() {},
    complete: async (body, { onDelta }) => {
      if (turn++ === 0) {
        onDelta(narration, 'Check the course sources.');
        return { role: 'assistant', content: narration };
      }
      if (turn === 2) return { role: 'assistant', content: null, tool_calls: [{ id: 'due', type: 'function', function: { name: 'list_upcoming', arguments: '{"days":7}' } }] };
      return { role: 'assistant', content: 'Quiz 5 is coming up.' };
    },
  });
  assert.deepEqual(answer.trace.filter(entry => entry.type !== 'thought').map(entry => entry.text ?? entry.name), [narration, 'list_upcoming']);
  assert.ok(observed.some(trace => trace.some(entry => entry.text === narration)));
  assert.equal(answer.text, 'Quiz 5 is coming up.');
});

test('activity previews show useful facts while bounding saved tool output', () => {
  const preview = toolPreview({ course: 'CS 25200', ai_use: { summary: 'Only for study.' }, syllabus_dates: [{ title: 'Midterm', due_display: 'Thursday' }] });
  assert.deepEqual(preview.map(item => item.text), ['CS 25200', 'Only for study.', 'Thursday']);
  const large = toolPreview({ results: Array.from({ length: 40 }, () => ({ title: 'Post', text: 'x'.repeat(10000) })) });
  assert.ok(large.length <= 6 && large.every(item => item.text.length <= 280));
});

test('past quizzes with more than forty questions page without gaps or scores', async () => {
  const tools = createTools({ snapshot: snapshotFixture(), readQuiz: async () => ({ questions: Array.from({ length: 45 }, (_, index) => ({ number: index + 1, text: `Question ${index + 1}` })), score: 99 }) });
  const results = [];
  let offset = 0;
  do {
    const page = await tools.run('read_quiz', { item_key: 'quiz:21', offset });
    results.push(...page.questions);
    assert.equal(page.score, undefined);
    offset = page.next_offset;
  } while (offset !== undefined);
  assert.deepEqual(results.map(question => question.number), Array.from({ length: 45 }, (_, index) => index + 1));
});
