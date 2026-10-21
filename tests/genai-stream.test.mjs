import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEventStream } from '../extension/lib/genai.js';

const encode = text => new TextEncoder().encode(text);
const event = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

test('the server done marker completes a reply without waiting for its connection to close', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encode(event({ content: 'Ready.' }) + 'data: [DONE]\n\n')); },
    cancel() { cancelled = true; },
  });
  const reply = await readEventStream(body, () => {}, { idleMs: 30 });
  assert.equal(reply.content, 'Ready.');
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('Stop cancels a quiet response immediately and releases its reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const reply = readEventStream(body, () => {}, { signal: controller.signal, idleMs: 100 });
  controller.abort();
  await assert.rejects(reply, error => error.name === 'AbortError');
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('keepalive comments cannot keep an empty reply waiting forever', async () => {
  let timer;
  const body = new ReadableStream({
    start(controller) { timer = setInterval(() => controller.enqueue(encode(': keepalive\n\n')), 3); },
    cancel() { clearInterval(timer); },
  });
  try { await assert.rejects(readEventStream(body, () => {}, { idleMs: 30 }), /stopped responding/); }
  finally { clearInterval(timer); }
  assert.equal(body.locked, false);
});

test('a server error releases the response reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encode('data: {"error":{"message":"Model failed"}}\n\n')); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readEventStream(body), /Model failed/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
