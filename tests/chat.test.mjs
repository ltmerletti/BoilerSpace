import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTitle, chatDate, generateChatTitle } from '../extension/lib/chat.js';
import { thinkingLevels, thinkingParams } from '../extension/lib/thinking.js';

test('chat titles fit the header and generated titles do not expose reasoning', async () => {
  assert.equal(chatTitle('"CS 250 midterm review"'), 'CS 250 midterm review');
  assert.ok(chatTitle('I am doing my first bit of review for the midterm and need help').length <= 32);
  let request;
  const title = await generateChatTitle([{ role: 'user', content: 'When is the CS 250 midterm?' }, { role: 'assistant', content: 'Thursday.' }], {
    complete: async body => { request = body; return { content: '<think>Decide on a name</think>\nCS 250 midterm review' }; },
  });
  assert.equal(title, 'CS 250 midterm review');
  assert.equal(request.tools, undefined);
  await assert.rejects(generateChatTitle([], { complete: async () => ({ content: '<think>Unfinished' }) }), /no chat title/);
});

test('chat dates use relative days inside four weeks and calendar dates for older chats', () => {
  const now = new Date('2026-10-17T18:00:00Z');
  assert.equal(chatDate('2026-10-17T15:00:00Z', now), 'Today');
  assert.equal(chatDate('2026-10-16T15:00:00Z', now), 'Yesterday');
  assert.equal(chatDate('2026-10-02T15:00:00Z', now), '15 days ago');
  assert.match(chatDate('2026-09-01T15:00:00Z', now), /Sep 1/);
});

test('thinking controls preserve the default request and only send supported levels', () => {
  assert.deepEqual(thinkingParams('qwen3.8:27b', 'default'), {});
  assert.deepEqual(thinkingParams('qwen3.8:27b', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(thinkingParams('qwen3.8:27b', 'off'), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(thinkingParams('gpt-oss:120b', 'xhigh'), {});
  assert.deepEqual(thinkingLevels('llama3.3:70b'), []);
});
