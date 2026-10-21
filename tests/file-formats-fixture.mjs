import { zipSync, strToU8 } from '../extension/vendor/fflate/fflate.js';
import { RTF_LECTURE } from './rtf-fixture.mjs';

const slide = '<p:sld><a:p><a:r><a:t>Use the exponent bias of 127.</a:t></a:r></a:p></p:sld>';
const word = '<w:document><w:p><w:r><w:t>Submit the source file.</w:t></w:r></w:p></w:document>';
const zip = files => [...zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))];
const text = value => [...strToU8(value)];

// Synthetic downloads. No account, course capture, macro, notebook output or code is executed.
export const COURSE_FILE_FIXTURES = [
  { id: 991101, fileName: 'lecture.rtf', contentType: 'application/rtf', bytes: text(RTF_LECTURE), location: 'part 1', expected: '23-bit fraction and an exponent bias of 127' },
  { id: 991102, fileName: 'lab.py', bytes: text('def solve():\n    return 42'), location: 'lines 1–2', expected: '    return 42' },
  { id: 991103, fileName: 'data.csv', bytes: text('topic,week\nWaves,1'), location: 'lines 1–2', expected: 'Waves,1' },
  { id: 991104, fileName: 'lab.ipynb', bytes: text(JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'markdown', source: ['# Lab\n', 'Submit the notebook source.'] }, { cell_type: 'code', source: 'def solve():\n    return 42', outputs: [{ text: 'EXCLUDED_NOTEBOOK_OUTPUT' }] }] })), location: 'cell 2', expected: '    return 42' },
  { id: 991105, fileName: null, bytes: zip({ 'ppt/slides/slide1.xml': slide }), location: 'slide 1', expected: 'exponent bias of 127' },
  { id: 991106, fileName: 'lecture.ppsm', bytes: zip({ 'ppt/slides/slide1.xml': slide, 'ppt/vbaProject.bin': 'EXCLUDED_MACRO_PAYLOAD' }), location: 'slide 1', expected: 'exponent bias of 127' },
  { id: 991107, fileName: 'instructions.dotm', bytes: zip({ 'word/document.xml': word, 'word/vbaProject.bin': 'EXCLUDED_MACRO_PAYLOAD' }), location: 'part 1', expected: 'Submit the source file' },
  { id: 991108, fileName: null, title: 'starter.py', bytes: text('def solve():\n    return 42'), location: 'lines 1–2', expected: '    return 42' },
  { id: 991109, fileName: null, title: 'starter.ipynb', bytes: text(JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'markdown', source: 'Submit the notebook source.', outputs: [{ text: 'EXCLUDED_NOTEBOOK_OUTPUT' }] }] })), location: 'cell 1', expected: 'Submit the notebook source.' },
];

// Serialized into the actual extension panel in both browsers; uses the real download bridge.
export async function checkCourseFileFormats({ snapshot, fixtures }) {
  const { ask } = await import('./lib/agent.js');
  const results = [];
  for (const file of fixtures) {
    const topic = { id: file.id, courseId: 1600001, title: file.fileName || file.title || 'Unnamed lecture', modulePath: [], fileUrl: `/d2l/api/le/1.96/1600001/content/topics/${file.id}/file`, url: `https://purdue.brightspace.com/c/${file.id}`, isHidden: false };
    const course = snapshot.data.find(course => course.courseId === 1600001);
    course.content = [topic];
    let evidence;
    const answer = await ask({ snapshot, syllabi: {}, question: 'Read this course file and explain its instructions.', complete: async ({ messages }) => {
      const result = messages.findLast(message => message.role === 'tool');
      if (!result) return { role: 'assistant', content: null, tool_calls: [{ id: 'files', type: 'function', function: { name: 'list_course_files', arguments: JSON.stringify({ course_id: 1600001 }) } }] };
      const body = JSON.parse(result.content);
      if (body.files) return { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_course_file', arguments: JSON.stringify({ file_key: body.files.find(file => file.file_key === `content:${topic.id}`).file_key, location: file.location, see_images: true }) } }] };
      evidence = body;
      return { role: 'assistant', content: `${body.excerpts?.[0]?.text ?? JSON.stringify(body)} [${body.excerpts?.[0]?.source ?? 'missing'}]` };
    } });
    const excerpt = evidence?.excerpts?.[0];
    results.push({ name: file.fileName || `${file.title || 'PowerPoint'} without download metadata`, pass: excerpt?.location === file.location && excerpt.text.includes(file.expected) && answer.citations?.[0]?.url === topic.url && !/EXCLUDED_|Pictures could not be opened/.test(JSON.stringify(evidence)), tools: answer.trace.filter(entry => entry.type === 'tool').map(entry => entry.name) });
  }
  return results;
}
