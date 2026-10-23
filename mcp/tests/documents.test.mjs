import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument } from '../lib/documents.mjs';
import { COURSE_FILE_FIXTURES } from '../../tests/file-formats-fixture.mjs';
import { pdfWithPages } from '../../tests/helpers.mjs';
import { workerRequest } from '../lib/worker.mjs';
import { extractText } from '../../extension/lib/extract.js';
import { strToU8, zipSync } from '../../extension/vendor/fflate/fflate.js';

test('the standalone reader preserves PDF page evidence without a browser extension', async () => {
  const result = await extractDocument({ bytes: pdfWithPages([['Radiation wavelength'], ['Learning objective: explain frequency']]), fileName: 'lecture.pdf' });
  assert.equal(result.kind, 'pdf');
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[1].label, 'page 2');
  assert.match(result.pages[1].text, /explain frequency/);
});

test('sparse PDF pages are flagged even when neighboring pages have readable text', async () => {
  const result = await extractDocument({ bytes: pdfWithPages([['Detailed readable evidence '.repeat(10)], []]), fileName: 'mixed.pdf' });
  assert.match(result.warning, /1 of 2 pages/);
});

test('parser workers contain incidental logs, enforce deadlines and abort cleanly', async () => {
  const noisy = new URL(`data:text/javascript,${encodeURIComponent('import {parentPort} from "node:worker_threads"; console.log("not a protocol message"); parentPort.postMessage({data:{ok:true}});')}`);
  assert.deepEqual(await workerRequest(noisy, {}), { ok: true });
  const stuck = new URL(`data:text/javascript,${encodeURIComponent('setInterval(() => {}, 1000);')}`);
  await assert.rejects(workerRequest(stuck, {}, { timeout: 30 }), { code: 'document-timeout' });
  const controller = new AbortController();
  const pending = workerRequest(stuck, {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('existing RTF, Office, source and notebook readers are reused without executing course content', async () => {
  for (const file of COURSE_FILE_FIXTURES) {
    const result = await extractDocument({ bytes: new Uint8Array(file.bytes), fileName: file.fileName || file.title || '', contentType: file.contentType });
    assert.ok(result.pages.some(page => page.label === file.location && page.text.includes(file.expected)), file.fileName || file.title || 'unnamed file');
    assert.ok(!JSON.stringify(result).includes('EXCLUDED_'));
  }
});

test('the shared Office reader accepts an explicit container budget while preserving extracted text limits', async () => {
  const bytes = zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:t>Bounded lecture text</a:t></a:p></p:sld>') });
  const file = { bytes, fileName: 'lecture.pptx' };
  await assert.rejects(extractText(file, { maxArchiveBytes: 10 }), /reading limit/);
  const result = await extractText(file, { maxArchiveBytes: bytes.length });
  assert.match(result.pages[0].text, /Bounded lecture text/);
});
