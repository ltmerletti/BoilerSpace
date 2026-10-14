// PDF extraction needs the browser build of pdf.js, so it is checked in scripts/verify.mjs instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../extension/vendor/fflate/fflate.js';
import { docxXmlToText, extractText, htmlToText } from '../extension/lib/extract.js';

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

test('HTML drops scripts and keeps line structure', () => {
  assert.equal(htmlToText('<h1>Syllabus</h1><script>alert(1)</script><p>Late work:&nbsp;no credit</p>'), 'Syllabus\nLate work: no credit');
});
