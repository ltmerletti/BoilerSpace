import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatScrollFollow } from '../extension/lib/chat-scroll.js';

function fixture() {
  const follow = createChatScrollFollow();
  const el = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500, closest: () => null };
  const handlers = follow.handlers();
  const event = (type, props = {}) => handlers[`on${type}`]({ currentTarget: el, target: el, preventDefault() {}, ...props });
  return { follow, el, event };
}

test('upward intent stays paused even within the bottom tolerance', () => {
  const { follow, el, event } = fixture();
  event('wheel', { deltaY: -0.5 });
  el.scrollTop = 499.5;
  event('scroll');
  assert.equal(follow.following, false);
  el.scrollTop = 500;
  event('scroll');
  assert.equal(follow.following, false);
});

test('downward user input resumes when it reaches the bottom', () => {
  const { follow, el, event } = fixture();
  follow.pause();
  el.scrollTop = 400;
  event('wheel', { deltaY: 100 });
  el.scrollTop = 500;
  event('scroll');
  assert.equal(follow.following, true);
});

test('moving a disclosure into view pauses following without making passive bottom scrolls resume it', () => {
  const { follow, el, event } = fixture();
  el.scrollTop = 400;
  event('scroll');
  assert.equal(follow.following, false);
  el.scrollTop = 500;
  event('scroll');
  assert.equal(follow.following, false);
});

test('scroll events, layout clamping, and application scroll restores cannot resume following', () => {
  const { follow, el, event } = fixture();
  follow.pause();
  event('scroll');
  assert.equal(follow.following, false);
  el.scrollTop = 400;
  event('wheel', { deltaY: 100 });
  el.scrollHeight = 900;
  event('scroll');
  assert.equal(follow.following, false);
  el.scrollTop = 300;
  event('wheel', { deltaY: 100 });
  follow.restore(el, 400);
  event('scroll');
  assert.equal(follow.following, false);
});

test('keyboard navigation and scrollbar dragging express direction', () => {
  const { follow, el, event } = fixture();
  event('keydown', { key: 'ArrowUp' });
  el.scrollTop = 450;
  event('scroll');
  assert.equal(follow.following, false);
  event('keydown', { key: 'End' });
  el.scrollTop = 500;
  event('scroll');
  assert.equal(follow.following, true);
  event('pointerdown');
  el.scrollTop = 400;
  event('scroll');
  assert.equal(follow.following, false);
  el.scrollTop = 500;
  event('pointerup');
  assert.equal(follow.following, true);
});

test('End resumes immediately and survives an older scrollend followed by new text', () => {
  const { follow, el, event } = fixture();
  let top = 400, prevented = false;
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: value => { top = Math.min(value, el.scrollHeight - el.clientHeight); } });
  follow.pause();
  event('keydown', { key: 'End', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'native keyboard animation cannot race the next streamed token');
  assert.equal(follow.following, true);
  assert.equal(el.scrollTop, 500);
  event('scrollend');
  el.scrollHeight += 300;
  follow.restore(el, follow.following ? el.scrollHeight : el.scrollTop);
  event('scroll');
  assert.equal(follow.following, true);
  assert.equal(el.scrollTop, 800);
});

test('End in the composer is left to normal text editing', () => {
  const { follow, el, event } = fixture();
  let prevented = false;
  follow.pause();
  event('keydown', { key: 'End', target: { closest: () => ({}) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(follow.following, false);
  assert.equal(el.scrollTop, 500);
});

test('touch direction pauses and deliberately resumes at the bottom', () => {
  const { follow, el, event } = fixture();
  event('touchstart', { touches: [{ clientY: 100 }] });
  event('touchmove', { touches: [{ clientY: 120 }] });
  el.scrollTop = 480;
  event('scroll');
  assert.equal(follow.following, false);
  event('touchmove', { touches: [{ clientY: 80 }] });
  el.scrollTop = 500;
  event('scroll');
  assert.equal(follow.following, true);
});

test('disclosure activation pauses and a new question resets following', () => {
  const { follow, event } = fixture();
  const summary = { closest: selector => selector === 'summary' ? summary : null };
  event('pointerdown', { target: summary });
  assert.equal(follow.following, false);
  follow.reset();
  assert.equal(follow.following, true);
  event('keydown', { key: 'Enter', target: summary });
  assert.equal(follow.following, false);
  follow.reset();
  event('click', { target: summary });
  assert.equal(follow.following, false);
});

test('late scroll events from a replaced view cannot change following', () => {
  const { follow, el, event } = fixture();
  el.scrollTop = 400;
  event('wheel', { deltaY: 100 });
  follow.pause();
  el.isConnected = false;
  el.scrollTop = 500;
  event('scroll');
  assert.equal(follow.following, false);
});
