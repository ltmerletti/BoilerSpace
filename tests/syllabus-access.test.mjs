import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, snapshotFixture } from './helpers.mjs';
import { reportSyllabusAccess, isSyllabusAccessError, SYLLABUS_SITE } from '../extension/lib/syllabus-access.js';
import { createTools } from '../extension/lib/agent.js';

test('site access is reported to every panel and changes when permission is granted', async () => {
  const stored = installChrome();
  let granted = false;
  chrome.permissions = { contains: async ({ origins }) => { assert.deepEqual(origins, [SYLLABUS_SITE]); return granted; } };
  assert.equal(await reportSyllabusAccess(), false);
  assert.equal(stored.syllabusAccess, false);
  granted = true;
  assert.equal(await reportSyllabusAccess(), true);
  assert.equal(stored.syllabusAccess, true);
});

test('syllabus facts report missing permission instead of sending the assistant through project handouts', async () => {
  installChrome();
  const error = 'BoilerSpace needs access to purdue.simplesyllabus.com to read this syllabus.';
  assert.equal(isSyllabusAccessError(error), true);
  const tools = createTools({ snapshot: snapshotFixture(), syllabi: { 1600001: { status: 'error', error } } });
  const facts = await tools.run('get_syllabus_facts', { course_id: 1600001 });
  assert.equal(facts.blocked, true);
  assert.deepEqual(facts.candidate_files, []);
  assert.match(facts.note, /Allow Simple Syllabus access/);
});
