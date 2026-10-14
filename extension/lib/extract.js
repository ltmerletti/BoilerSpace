// Text extraction for course files, kept page by page (or part / slide) so answers can cite a location.

import { strFromU8, unzipSync } from '../vendor/fflate/fflate.js';

const DOCX_PART_CHARS = 3500;
const SCANNED_PDF_CHARS_PER_PAGE = 40;

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ??= import('../vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
    return pdfjs;
  });
  return pdfjsPromise;
}

export function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const tidy = (text) => text.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export function detectKind(bytes, fileName = '', contentType = '') {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (/\.pptx$/i.test(fileName) || /presentation/i.test(contentType)) return 'pptx';
    return 'docx';
  }
  if (/html/i.test(contentType) || /\.html?$/i.test(fileName)) return 'html';
  if (/^text\//i.test(contentType) || /\.(txt|md)$/i.test(fileName)) return 'text';
  return 'unknown';
}

async function extractPdf(bytes) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'),
  }).promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('');
    pages.push({ page: number, label: `page ${number}`, text: tidy(text) });
  }
  await doc.destroy();
  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  const warning =
    totalChars < SCANNED_PDF_CHARS_PER_PAGE * pages.length
      ? 'This PDF has little or no selectable text. It is probably a scan, and BoilerSpace does not run OCR.'
      : null;
  return { pages, warning };
}

export function docxXmlToText(xml) {
  return tidy(
    decodeXmlEntities(
      xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    ),
  );
}

function splitIntoParts(text) {
  const parts = [];
  let current = '';
  for (const paragraph of text.split('\n')) {
    if (current && current.length + paragraph.length > DOCX_PART_CHARS) {
      parts.push(current.trim());
      current = '';
    }
    current += paragraph + '\n';
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((partText, i) => ({ page: i + 1, label: `part ${i + 1}`, text: partText }));
}

function extractDocx(bytes) {
  const files = unzipSync(bytes, { filter: (file) => file.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('This file is not a Word document.');
  return { pages: splitIntoParts(docxXmlToText(strFromU8(xml))), warning: null };
}

function extractPptx(bytes) {
  const files = unzipSync(bytes, { filter: (file) => /^ppt\/slides\/slide\d+\.xml$/.test(file.name) });
  const slides = Object.entries(files)
    .map(([name, data]) => ({ number: Number(/slide(\d+)\.xml$/.exec(name)[1]), xml: strFromU8(data) }))
    .sort((a, b) => a.number - b.number);
  const pages = slides.map(({ number, xml }) => {
    const text = [...xml.replace(/<\/a:p>/g, '\n<a:t>\n</a:t>').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');
    return { page: number, label: `slide ${number}`, text: tidy(decodeXmlEntities(text)) };
  });
  return { pages, warning: pages.every((p) => !p.text) ? 'These slides have no text.' : null };
}

export function htmlToText(html) {
  return tidy(
    decodeXmlEntities(
      html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

export async function extractText({ bytes, fileName = '', contentType = '' }) {
  const kind = detectKind(bytes, fileName, contentType);
  if (kind === 'pdf') return { kind, ...(await extractPdf(bytes)) };
  if (kind === 'docx') return { kind, ...extractDocx(bytes) };
  if (kind === 'pptx') return { kind, ...extractPptx(bytes) };
  if (kind === 'html' || kind === 'text') {
    const raw = new TextDecoder().decode(bytes);
    return { kind, pages: splitIntoParts(kind === 'html' ? htmlToText(raw) : tidy(raw)), warning: null };
  }
  return { kind, pages: [], warning: `BoilerSpace cannot read this file type (${contentType || fileName || 'unknown'}).` };
}
