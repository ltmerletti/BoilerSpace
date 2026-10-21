// PDF extraction needs the browser build of pdf.js, so it is checked in scripts/verify.mjs instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../extension/vendor/fflate/fflate.js';
import { detectKind, docxXmlToText, extractText, htmlToText } from '../extension/lib/extract.js';
import { RTF_LECTURE } from './rtf-fixture.mjs';

const rtf = async (text, options = {}) => extractText({ bytes: Uint8Array.from(text, char => char.charCodeAt(0)), ...options });

test('RTF is recognized by signature, MIME type and filename, before plain text', async () => {
  for (const options of [{}, { contentType: 'application/rtf' }, { contentType: 'text/rtf; charset=us-ascii' }, { contentType: 'application/octet-stream', fileName: 'notes.RTF' }]) {
    const result = await rtf(RTF_LECTURE, options);
    assert.equal(result.kind, 'rtf');
    assert.match(result.pages[0].text, /23-bit fraction and an exponent bias of 127/);
    assert.match(result.pages[0].text, /Reference notes/);
    assert.doesNotMatch(result.pages[0].text, /Arial|Hidden fixture|HYPERLINK|example.invalid|89504|\\rtf/);
    assert.equal(result.pages[0].label, 'part 1');
    assert.match(result.warning, /Pictures and embedded objects.*skipped/);
  }
  assert.equal(detectKind(new TextEncoder().encode('%PDF-1.7'), 'wrong.rtf', 'application/rtf'), 'pdf');
  assert.equal(detectKind(new TextEncoder().encode('ordinary text'), '', 'application/x-rtf'), 'rtf');
  assert.equal(detectKind(new TextEncoder().encode('<!doctype html>Sign in'), 'notes.rtf', 'text/html'), 'html');
});

test('RTF nested formatting, escaped punctuation, tables and line breaks preserve readable text', async () => {
  const result = await rtf(String.raw`{\rtf1\ansi Title\par {\b Bold {\i nested}} normal.\line \{x\} \\ y\tab cell\cell next\row End\page More}`);
  assert.equal(result.pages[0].text, 'Title\nBold nested normal.\n{x} \\ y cell next\nEnd\n\nMore');
  assert.equal(result.warning, null);
});

test('RTF Unicode fallback counts and font encodings are scoped to their groups', async () => {
  const result = await rtf(String.raw`{\rtf1\ansi\ansicpg1252 Caf\'e9 \u945? {\uc2\u946??} \u947\'3f \uc0\u-10179\u-8704 {\v Hidden} Visible}`);
  assert.equal(result.pages[0].text, 'Café α β γ 😀 Visible');
  const fonts = await rtf(String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset0 Latin;}{\f1\fcharset204 Cyrillic;}}\f1\'cf\'f0\'e8\'e2\'e5\'f2\f0  Caf\'e9}`);
  assert.equal(fonts.pages[0].text, 'Привет Café');
  const japanese = await rtf(String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`);
  assert.equal(japanese.pages[0].text, 'あ');
  const mac = await rtf(String.raw`{\rtf1\ansi{\fonttbl{\f1\fcharset77 Palatino;}}{\pntext n\tab}\f1 \'d0 Text}`);
  assert.equal(mac.pages[0].text, '– Text');
});

test('RTF ignores destinations and binary content without losing following text', async () => {
  const result = await rtf(String.raw`{\rtf1 Start {\*\unknown secret {\b nested}}{\object\objdata\bin5 {}\ab} End {\upr{ANSI}{\*\ud Unicode \uc0\u945}}}`);
  assert.equal(result.pages[0].text, 'Start End Unicode α');
  assert.match(result.warning, /objects.*skipped/);
});

test('RTF raw legacy bytes, UTF-8 BOM and decoder chunk boundaries are handled', async () => {
  const result = await rtf('\xef\xbb\xbf  {\\rtf1\\ansi Caf\xe9}');
  assert.equal(result.pages[0].text, 'Café');
  const utf8 = await rtf('{\\rtf1\\ansi\\ansicpg65001 ' + 'a'.repeat(8191) + '\xe2\x82\xac}');
  assert.equal(utf8.pages[0].text, 'a'.repeat(8191) + '€');
});

test('RTF rejects malformed or unsupported input instead of returning partial evidence', async () => {
  for (const text of [String.raw`{\rtf1 unfinished`, String.raw`{\rtf1 bad \'zz}`, String.raw`{\rtf1{\pict\bin999 ab}}`, String.raw`{\rtf1\uc-1 bad}`, String.raw`{\rtf1\u999999?}`, String.raw`{\rtf1 good}extra`, 'not RTF']) {
    await assert.rejects(rtf(text, { fileName: 'notes.rtf' }), /RTF/);
  }
  await assert.rejects(rtf(String.raw`{\rtf1\ansicpg99999 \'ff}`), /unsupported character encoding/);
  await assert.rejects(rtf('{\\rtf1' + '{'.repeat(260) + 'text' + '}'.repeat(261)), /nested groups/);
  const empty = await rtf(String.raw`{\rtf1{\pict 0102}}`);
  assert.deepEqual(empty.pages, []);
  assert.match(empty.warning, /no readable text/);
});

test('DOCX paragraphs, tabs and entities come through', () => {
  const xml = '<w:p><w:r><w:t>Exam 1</w:t></w:r><w:r><w:tab/><w:t>Oct 21 &amp; 22</w:t></w:r></w:p><w:p><w:r><w:t>Room &lt;TBA&gt;</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml), 'Exam 1 Oct 21 & 22\nRoom <TBA>');
});

test('PPTX slides are read in numeric order', async () => {
  const slide = (text) => strToU8(`<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p><a:p><a:r><a:t>second line</a:t></a:r></a:p></p:sld>`);
  const bytes = zipSync({ 'ppt/slides/slide10.xml': slide('Ten'), 'ppt/slides/slide2.xml': slide('Two'), 'ppt/slides/slide1.xml': slide('One') });
  const result = await extractText({ bytes, fileName: 'Course overview.pptx' });
  assert.equal(result.kind, 'pptx');
  assert.deepEqual(result.pages.map((p) => p.label), ['slide 1', 'slide 2', 'slide 10']);
  assert.equal(result.pages[0].text, 'One\nsecond line');
});

test('a slide deck read skips pictures and can still pull the pictures on one slide', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const slide = strToU8('<p:sld><a:blip r:embed="rId2"/><a:p><a:r><a:t>Learning objective</a:t></a:r></a:p></p:sld>');
  const rels = strToU8('<Relationships><Relationship Id="rId2" Type="image" Target="../media/image1.png"/></Relationships>');
  const bytes = zipSync({
    'ppt/slides/slide3.xml': slide,
    'ppt/slides/_rels/slide3.xml.rels': rels,
    'ppt/media/image1.png': png,
  });
  const { slidePictures, extractText } = await import('../extension/lib/extract.js');
  const result = await extractText({ bytes, fileName: 'topic.pptx' });
  assert.equal(result.pages[0].text, 'Learning objective');
  assert.match(result.warning, /Pictures in this deck were skipped/);
  assert.equal(JSON.stringify(result.pages).includes('iVBORw0'), false);
  const pictures = slidePictures(bytes, 'slide 3');
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].mediaType, 'image/png');
  assert.deepEqual([...pictures[0].bytes], [...png]);
  assert.deepEqual(slidePictures(bytes, 'slide 1'), []);
});

test('an HTML syllabus with no file name is still read as text', async () => {
  const bytes = new TextEncoder().encode('<!doctype html><h1>Syllabus</h1><p>Late work is not accepted.</p>');
  const { extractText } = await import('../extension/lib/extract.js');
  const result = await extractText({ bytes, fileName: '', contentType: '' });
  assert.equal(result.kind, 'html');
  assert.match(result.pages[0].text, /Late work is not accepted/);
});

test('HTML drops scripts and keeps line structure', () => {
  assert.equal(htmlToText('<h1>Syllabus</h1><script>alert(1)</script><p>Late work:&nbsp;no credit</p>'), 'Syllabus\nLate work: no credit');
});
