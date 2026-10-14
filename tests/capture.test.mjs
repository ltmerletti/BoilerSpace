import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFixture } from './helpers.mjs';
import { captureBenchmark } from '../extension/lib/capture.js';

test('a benchmark capture has course files but no grades, name or contact details', async () => {
  const snapshot = snapshotFixture();
  snapshot.user = { firstName: 'Boiler', lastName: 'Maker', id: 12345 };
  snapshot.data[0].announcements[0].body = 'Questions? Email prof@purdue.edu or call (765) 494-0000.';
  snapshot.data[0].content.push({ id: 79, courseId: 1600001, title: 'Lecture 1 recording.mp4', modulePath: ['Week 1'], type: 'File', fileUrl: '/d2l/api/le/1.96/1600001/content/topics/79/file', isHidden: false });
  const opened = [];
  const readFile = async (topic) => {
    opened.push(topic.id);
    if (topic.id === 78) throw new Error('This PDF has no text layer.');
    return { kind: 'pdf', pages: [{ page: 1, label: 'page 1', text: 'Office hours: email ta@purdue.edu.' }] };
  };

  const capture = await captureBenchmark({ snapshot, chats: [{ messages: [{ role: 'user', content: 'When is my midterm?' }, { role: 'assistant', content: 'Oct 21.' }] }], readFile });
  const text = JSON.stringify(capture);

  assert.deepEqual(opened, [77, 78], 'videos are skipped');
  assert.equal(capture.files.find((f) => f.topicId === 77).pages[0].text, 'Office hours: email [email].');
  assert.equal(capture.files.find((f) => f.topicId === 78).error, 'This PDF has no text layer.');
  assert.deepEqual(capture.questions, ['When is my midterm?']);
  assert.ok(!text.includes('9 / 10'), 'no grades');
  assert.ok(!text.includes('Maker') && !text.includes('12345'), 'no name or user id');
  assert.ok(!text.includes('purdue.edu') && !text.includes('494-0000'), 'no emails or phone numbers');
  assert.ok(capture.data.every((d) => !('grades' in d)));
});
