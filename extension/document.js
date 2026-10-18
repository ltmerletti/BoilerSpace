import * as store from './lib/store.js';
import { courseFiles, readCourseFile } from './lib/files.js';
import { downloadTopicFile } from './lib/sync.js';
import { withSyllabusSources } from './lib/syllabus.js';

const title = document.getElementById('title');
const input = document.getElementById('page');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
const original = document.getElementById('original');
const status = document.getElementById('status');
const canvas = document.getElementById('pdf-page');
const text = document.getElementById('page-text');
const details = document.getElementById('text-details');
let pages = [];
let topic;
let pdf;
let rendering;
let showPdf = false;
let index = 0;

async function showPage() {
  if (!pages.length) return;
  const requested = Number(new URLSearchParams(location.hash.slice(1)).get('page')) || 1;
  index = pages.findIndex((p) => p.page === requested);
  if (index < 0) index = Math.min(Math.max(requested - 1, 0), pages.length - 1);
  const page = pages[index];
  input.value = page.page;
  previous.disabled = index === 0;
  next.disabled = index === pages.length - 1;
  text.textContent = page.text || 'This page has no selectable text. Show the original PDF to view it.';
  canvas.hidden = true;
  if (rendering) {
    rendering.cancel();
    try { await rendering.promise; } catch { /* a newer page replaces the old render */ }
  }
  if (showPdf && pdf) {
    const current = index;
    const pdfPage = await pdf.getPage(page.page);
    if (current !== index) return;
    const scale = Math.min(2, (window.innerWidth - 48) / pdfPage.getViewport({ scale: 1 }).width);
    const viewport = pdfPage.getViewport({ scale: Math.max(.25, scale) });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    rendering = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport });
    try {
      await rendering.promise;
      if (current === index && showPdf) canvas.hidden = false;
    } catch (err) {
      if (err.name !== 'RenderingCancelledException') throw err;
    }
  }
}

const changePage = (i) => { location.hash = `page=${pages[i].page}`; };
previous.addEventListener('click', () => changePage(index - 1));
next.addEventListener('click', () => changePage(index + 1));
input.addEventListener('change', () => {
  const value = Math.min(Math.max(Number(input.value) || 1, 1), pages.at(-1).page);
  input.value = value;
  location.hash = `page=${value}`;
});
window.addEventListener('hashchange', () => showPage().catch((err) => { status.textContent = err.message; }));
original.addEventListener('click', async () => {
  original.disabled = true;
  try {
    if (!pdf) {
      status.textContent = 'Opening the original PDF…';
      const file = await downloadTopicFile(topic.fileUrl, { open: false });
      if (!file.bytes) throw new Error('The original PDF could not be opened. The saved text is still available.');
      const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
      pdf = await pdfjs.getDocument({ data: file.bytes, isEvalSupported: false, wasmUrl: chrome.runtime.getURL('vendor/pdfjs/wasm/'), cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/') }).promise;
    }
    showPdf = !showPdf;
    original.textContent = showPdf ? 'Show saved text' : 'Show original PDF';
    details.open = !showPdf;
    await showPage();
    status.textContent = showPdf ? 'Original PDF' : 'Saved text from this course document.';
  } catch (err) {
    showPdf = false;
    original.textContent = 'Show original PDF';
    canvas.hidden = true;
    details.open = true;
    status.textContent = err.message;
  } finally {
    original.disabled = false;
  }
});

async function init() {
  const params = new URLSearchParams(location.search);
  const courseId = Number(params.get('course'));
  const all = await store.getAll();
  const snapshot = withSyllabusSources(all.snapshot, all.syllabusSources);
  topic = courseFiles(snapshot, courseId).find((file) => file.key === params.get('file'));
  if (!topic) throw new Error('This file is no longer in your synced course data. Sync Brightspace and open the citation again.');
  const loaded = await readCourseFile(topic, { syllabi: all.syllabi });
  pages = loaded.pages ?? [];
  if (!pages.length) throw new Error('No pages could be read from this document.');
  title.textContent = loaded.fileName || topic.title;
  document.title = `${title.textContent} · BoilerSpace`;
  document.getElementById('total').textContent = `of ${pages.at(-1).page}`;
  input.max = pages.at(-1).page;
  input.disabled = false;
  original.hidden = loaded.kind !== 'pdf' || !topic.fileUrl;
  status.textContent = loaded.warning || 'Saved text from this course document.';
  await showPage();
}

init().catch((err) => { status.textContent = err.message; });
