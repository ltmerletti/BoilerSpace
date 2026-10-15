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
