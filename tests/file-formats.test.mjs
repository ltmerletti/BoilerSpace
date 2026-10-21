import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../extension/vendor/fflate/fflate.js';
import { detectKind, extractText } from '../extension/lib/extract.js';
import { createTools } from '../extension/lib/agent.js';
import { readCourseFile, getCachedCourseFile } from '../extension/lib/files.js';
import { snapshotFixture } from './helpers.mjs';

const packed = files => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
const word = { 'word/document.xml': '<w:document><w:p><w:r><w:t>Course objectives</w:t></w:r></w:p></w:document>' };
const slides = { 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Course objectives</a:t></a:r></a:p></p:sld>' };
const textFile = (text, fileName, contentType = 'application/octet-stream') => ({ bytes: strToU8(text), fileName, contentType });
const notebook = cells => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells });

test('Office files are identified from entries, not missing or misleading download metadata', async () => {
  for (const [files, kind, names] of [[word, 'docx', ['', 'notes.docm', 'notes.dotx', 'notes.dotm', 'wrong.pptx']], [slides, 'pptx', ['', 'slides.pptm', 'slides.ppsx', 'slides.ppsm', 'slides.potx', 'slides.potm', 'wrong.docx']]]) {
    for (const fileName of names) {
      const result = await extractText({ bytes: packed({ ...files, 'vbaProject.bin': 'Never execute this' }), fileName, contentType: 'application/octet-stream' });
      assert.equal(result.kind, kind);
      assert.equal(result.pages[0].text, 'Course objectives');
      assert.doesNotMatch(JSON.stringify(result), /Never execute/);
    }
  }
});

test('spreadsheets, OpenDocument, ordinary ZIPs and ambiguous archives are not misreported as Word', async () => {
  for (const files of [{ 'xl/workbook.xml': '<workbook/>' }, { 'content.xml': '<document/>' }, { 'notes.txt': 'notes' }, { ...word, ...slides }]) {
    const result = await extractText({ bytes: packed(files), fileName: 'not-a-word-file.zip' });
    assert.equal(result.kind, 'unknown');
    assert.deepEqual(result.pages, []);
    assert.match(result.warning, /cannot read this file type/);
  }
  assert.throws(() => detectKind(strToU8('PK broken')), /zip|invalid/i);
});

test('archive inspection does not inflate unrelated payloads and bounds selected XML size and entry count', async () => {
  const payload = new Uint8Array(16_000_001);
  const ordinary = zipSync({ 'big.dat': payload });
  assert.equal(detectKind(ordinary), 'unknown');
  const tooMuchXml = zipSync({ 'word/document.xml': payload });
  assert.equal(detectKind(tooMuchXml), 'docx');
  await assert.rejects(extractText({ bytes: tooMuchXml }), /16 MB/);
  const tooMany = packed(Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`entry-${i}`, ''])));
  assert.throws(() => detectKind(tooMany), /too many archive entries/);
});

test('source and structured text are readable with a generic MIME type and retain indentation, tabs and line citations', async () => {
  const source = 'def example():\r\n\tif True:\r\n        return "λ"\r\n';
  for (const ext of ['py', 'c', 'h', 'cpp', 's', 'asm', 'v', 'sv', 'vhdl', 'java', 'js', 'ts', 'r', 'sql', 'sh', 'json', 'yaml', 'csv', 'tsv', 'tex', 'md', 'txt']) {
    const result = await extractText(textFile(source, `Lab.${ext}`));
    assert.equal(result.kind, 'text', ext);
    assert.equal(result.pages[0].text, source.replace(/\r\n/g, '\n'), ext);
    assert.equal(result.pages[0].label, 'lines 1–4');
  }
  for (const type of ['text/x-python', 'application/json', 'application/ld+json', 'application/xml']) {
    assert.equal((await extractText(textFile('Readable text', '', type))).kind, 'text');
  }
  for (const fileName of ['Makefile', 'Dockerfile']) assert.equal((await extractText(textFile(source, fileName))).kind, 'text');
  const result = await extractText(textFile('  first\n'.repeat(1100), 'large.py'));
  assert.ok(result.pages.length > 1);
  const ranges = result.pages.map(p => /^lines (\d+)–(\d+)$/.exec(p.label).slice(1).map(Number));
  assert.equal(ranges[0][0], 1);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
  assert.equal(result.pages.map(p => p.text).join('\n'), '  first\n'.repeat(1100));
});

test('text decoding handles BOMs and declared encodings, and rejects binary, oversized and undecodable input', async () => {
  const utf16 = Uint8Array.from([0xff, 0xfe, ...[...'Café'].flatMap(char => [char.charCodeAt(0), 0])]);
  assert.equal((await extractText({ bytes: utf16, fileName: 'notes.txt' })).pages[0].text, 'Café');
  assert.equal((await extractText({ bytes: Uint8Array.from([67, 97, 102, 233]), contentType: 'text/plain; charset="windows-1252"' })).pages[0].text, 'Café');
  for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(65, 0, 66)]) await assert.rejects(extractText({ bytes, fileName: 'lab.py' }), /decoded|binary/);
  await assert.rejects(extractText(textFile('text', 'notes.txt', 'text/plain; charset=made-up')), /unsupported character encoding/);
  await assert.rejects(extractText({ bytes: new Uint8Array(10_000_001), fileName: 'data.csv' }), /10 MB/);
  assert.equal(detectKind(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0]), 'old.doc', 'text/plain'), 'unknown');
});

test('notebooks read only cell sources, keep original cell numbers and skip outputs, metadata and attachments', async () => {
  const contents = notebook([
    { cell_type: 'markdown', source: ['# Lab\n', 'Follow the instructions.'], attachments: { image: 'Do not read attachment' } },
    { cell_type: 'code', source: '' },
    { cell_type: 'code', source: 'def solve():\n    return 42', outputs: [{ text: 'Do not read output' }], execution_count: 9, metadata: { note: 'Do not read metadata' } },
    { cell_type: 'raw', source: ['Submission requirements'] },
  ]);
  for (const [fileName, mime] of [['lab.ipynb', 'application/octet-stream'], ['', 'application/x-ipynb+json']]) {
    const result = await extractText(textFile(contents, fileName, mime));
    assert.equal(result.kind, 'notebook');
    assert.deepEqual(result.pages.map(p => [p.page, p.label]), [[1, 'cell 1'], [3, 'cell 3'], [4, 'cell 4']]);
    assert.equal(result.pages[1].text, 'def solve():\n    return 42');
    assert.doesNotMatch(JSON.stringify(result.pages), /Do not read|execution_count/);
    assert.match(result.warning, /outputs and attachments were skipped/);
  }
});

test('malformed and unsupported notebooks fail clearly rather than returning raw JSON as evidence', async () => {
  for (const text of ['not JSON', '{}', JSON.stringify({ nbformat: 3, cells: [] }), notebook([{ cell_type: 'code', source: [42] }]), notebook([{ cell_type: 'unknown', source: 'text' }])]) {
    await assert.rejects(extractText(textFile(text, 'lab.ipynb')), /notebook|Notebook/);
  }
  const empty = await extractText(textFile(notebook([]), 'empty.ipynb'));
  assert.deepEqual(empty.pages, []);
  assert.equal(empty.warning, null);
});

test('Ask opens and searches notebook cells, resolves their citations and never substitutes a PDF or reads saved outputs', async () => {
  const snapshot = snapshotFixture();
  const topic = { ...snapshot.data[0].content[1], id: 991003, title: 'Lab.ipynb' };
  snapshot.data[0].content = [topic];
  const downloads = [];
  const contents = notebook([{ cell_type: 'markdown', source: 'Submission requires the notebook source.' }, { cell_type: 'code', source: 'def solve():\n    return 42', outputs: [{ text: 'Private output' }] }]);
  const readFile = (file, options) => readCourseFile(file, { ...options, download: async () => {
    downloads.push(true);
    return textFile(contents, 'Lab.ipynb');
  } });
  const tools = createTools({ snapshot, syllabi: {}, readFile, cachedFile: getCachedCourseFile });
  const result = await tools.run('read_course_file', { file_key: `content:${topic.id}`, location: 'cell 2', see_images: true });
  assert.equal(result.excerpts[0].location, 'cell 2');
  assert.equal(result.excerpts[0].text, 'def solve():\n    return 42');
  assert.equal(tools.sources.get(result.excerpts[0].source).url, topic.url);
  assert.doesNotMatch(JSON.stringify(result), /Private output|PDF|Pictures could not/);
  const search = await tools.run('search_course_material', { course_id: topic.courseId, query: 'notebook source' });
  assert.ok(search.results.some(hit => hit.file_key === `content:${topic.id}` && hit.location === 'cell 1'));
  assert.equal(downloads.length, 2, 'a requested image check does not discard the cached text');
});
