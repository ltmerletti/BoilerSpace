// Text extraction for course files, kept page by page (or part / slide) so answers can cite a location.

import { strFromU8, unzipSync } from '../vendor/fflate/fflate.js';
import { rtfToText } from './rtf.js';
import { decodeText, notebookPages, textPages } from './text-files.js';

const DOCX_PART_CHARS = 3500;
const SCANNED_PDF_CHARS_PER_PAGE = 40;
const MAX_XML_BYTES = 16_000_000;
const TEXT_EXTENSION = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|cfg|log|tex|py|pyi|r|rmd|c|h|cc|cpp|cxx|hpp|s|asm|v|sv|vhd|vhdl|java|js|mjs|cjs|jsx|ts|tsx|css|sql|sh|bash|zsh|m|rs|go|rb|jl|scala|hs)$/i;

// Inspect entry names without inflating payloads. Reuse the same limits when reading XML.
function readArchive(bytes, select = () => false, maxArchiveBytes = 64_000_000) {
  if (bytes.length > maxArchiveBytes) throw new Error(`This document exceeds the ${maxArchiveBytes / 1_000_000} MB reading limit.`);
  let entries = 0, size = 0;
  return unzipSync(bytes, { filter(file) {
    if (++entries > 10_000) throw new Error('This document contains too many archive entries.');
    if (!select(file.name)) return false;
    size += file.originalSize;
    if (size > MAX_XML_BYTES) throw new Error('This document exceeds the 16 MB extracted-text limit.');
    return true;
  } });
}

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

function looksLikeHtml(bytes) {
  let head = '';
  const end = Math.min(bytes.length, 80);
  for (let i = 0; i < end; i++) head += String.fromCharCode(bytes[i]);
  const start = head.trimStart().slice(0, 40).toLowerCase();
  return start.startsWith('<!doctype html') || start.startsWith('<html') || start.startsWith('<head') || start.startsWith('<body');
}

export function detectKind(bytes, fileName = '', contentType = '', { maxArchiveBytes } = {}) {
  fileName ??= '';
  contentType ??= '';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let word = false, slides = false;
    readArchive(bytes, name => {
      word ||= name === 'word/document.xml';
      slides ||= /^ppt\/slides\/slide\d+\.xml$/.test(name);
      return false;
    }, maxArchiveBytes);
    return word && !slides ? 'docx' : slides && !word ? 'pptx' : 'unknown';
  }
  // Do not decode legacy Office binaries even if the server calls them text/plain.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'unknown';
  if (/html/i.test(contentType) || /\.html?$/i.test(fileName) || looksLikeHtml(bytes)) return 'html';
  const head = String.fromCharCode(...bytes.subarray(0, 40));
  if (/^(?:\xef\xbb\xbf)?\s*\{\\rtf\d/.test(head) || /^(application|text)\/(?:x-)?rtf(?:\s*;|$)/i.test(contentType) || /\.rtf$/i.test(fileName)) return 'rtf';
  if (/\.ipynb$/i.test(fileName) || /application\/x-ipynb\+json/i.test(contentType)) return 'notebook';
  if (/^text\//i.test(contentType) || /application\/(?:[^;]+\+)?(?:json|xml)(?:\s*;|$)|application\/(?:javascript|x-python|sql|yaml|toml)(?:\s*;|$)/i.test(contentType) || TEXT_EXTENSION.test(fileName) || /^(makefile|dockerfile)$/i.test(fileName)) return 'text';
  return 'unknown';
}

async function extractPdf(bytes) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    wasmUrl: chrome.runtime.getURL('vendor/pdfjs/wasm/'),
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
      ? 'This PDF has little or no selectable text. It is probably a scan. Open one page with see_images to read the picture.'
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

function extractDocx(bytes, maxArchiveBytes) {
  const files = readArchive(bytes, name => name === 'word/document.xml', maxArchiveBytes);
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('This file is not a Word document.');
  return { pages: splitIntoParts(docxXmlToText(strFromU8(xml))), warning: null };
}

function extractPptx(bytes, maxArchiveBytes) {
  let pictures = 0;
  const files = readArchive(bytes, name => {
    if (/^ppt\/media\//.test(name)) {
      pictures += 1;
      return false;
    }
    return /^ppt\/slides\/slide\d+\.xml$/.test(name);
  }, maxArchiveBytes);
  const slides = Object.entries(files)
    .map(([name, data]) => ({ number: Number(/slide(\d+)\.xml$/.exec(name)[1]), xml: strFromU8(data) }))
    .sort((a, b) => a.number - b.number);
  const pages = slides.map(({ number, xml }) => {
    const text = [...xml.replace(/<\/a:p>/g, '\n<a:t>\n</a:t>').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');
    return { page: number, label: `slide ${number}`, text: tidy(decodeXmlEntities(text)) };
  });
  const warning = [
    pages.every((p) => !p.text) ? 'These slides have no text.' : null,
    pictures ? 'Pictures in this deck were skipped.' : null,
  ].filter(Boolean).join(' ') || null;
  return { pages, warning };
}

const PICTURE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const PICTURE_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_PICTURE_BYTES = 40_000_000;
const MAX_PICTURES = 4;

function mediaName(target) {
  try {
    return `ppt/media/${decodeURIComponent(target.split('/').pop())}`;
  } catch {
    return '';
  }
}

// Pictures on one slide. The zip is scanned again so the rest of the deck's photos stay packed.
export function slidePictures(bytes, location) {
  const number = /(\d+)\s*$/.exec(String(location ?? ''))?.[1];
  if (!number) return [];
  const packed = unzipSync(bytes, {
    filter: (file) => file.name === `ppt/slides/slide${number}.xml` || file.name === `ppt/slides/_rels/slide${number}.xml.rels`,
  });
  const slide = packed[`ppt/slides/slide${number}.xml`];
  const rels = packed[`ppt/slides/_rels/slide${number}.xml.rels`];
  if (!slide || !rels) return [];
  const targets = new Map();
  for (const rel of strFromU8(rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(rel[1])?.[1];
    const target = /Target="([^"]+)"/.exec(rel[1])?.[1];
    if (id && target) targets.set(id, mediaName(target));
  }
  const names = [];
  for (const embed of strFromU8(slide).matchAll(/r:embed="([^"]+)"/g)) {
    const name = targets.get(embed[1]);
    if (name && PICTURE_NAME.test(name) && !names.includes(name)) names.push(name);
  }
  const pictures = [];
  for (const name of names.slice(0, MAX_PICTURES)) {
    const media = unzipSync(bytes, { filter: (file) => file.name === name && file.originalSize <= MAX_PICTURE_BYTES });
    const data = media[name];
    if (!data) continue;
    const ext = name.split('.').pop().toLowerCase();
    pictures.push({ bytes: data, mediaType: PICTURE_TYPE[ext] });
  }
  return pictures;
}

export async function pagePicture(bytes, location) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const number = Number(/(\d+)\s*$/.exec(String(location ?? ''))?.[1]);
  if (!number) return null;
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    wasmUrl: chrome.runtime.getURL('vendor/pdfjs/wasm/'),
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'),
  }).promise;
  try {
    if (number > doc.numPages) return null;
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1280 / Math.max(base.width, base.height)) });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const canvasContext = canvas.getContext('2d');
    await page.render({ canvasContext, viewport, canvas }).promise;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    let binary = '';
    const raw = new Uint8Array(await blob.arrayBuffer());
    for (let i = 0; i < raw.length; i += 0x8000) {
      const end = Math.min(i + 0x8000, raw.length);
      const codes = new Array(end - i);
      for (let j = i; j < end; j++) codes[j - i] = raw[j];
      binary += String.fromCharCode.apply(null, codes);
    }
    return { mediaType: 'image/jpeg', data: btoa(binary) };
  } finally {
    await doc.destroy();
  }
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

export async function extractText({ bytes, fileName = '', contentType = '' }, options = {}) {
  const kind = detectKind(bytes, fileName, contentType, options);
  if (kind === 'pdf') return { kind, ...(await extractPdf(bytes)) };
  if (kind === 'docx') return { kind, ...extractDocx(bytes, options.maxArchiveBytes) };
  if (kind === 'pptx') return { kind, ...extractPptx(bytes, options.maxArchiveBytes) };
  if (kind === 'rtf') {
    const { text, pictures } = rtfToText(bytes);
    const pages = splitIntoParts(tidy(text));
    const warning = [!pages.length ? 'This RTF has no readable text.' : null, pictures ? 'Pictures and embedded objects in this RTF were skipped.' : null].filter(Boolean).join(' ') || null;
    return { kind, pages, warning };
  }
  if (kind === 'html' || kind === 'text' || kind === 'notebook') {
    const raw = decodeText(bytes, contentType);
    if (kind === 'notebook') return { kind, ...notebookPages(raw) };
    return { kind, pages: kind === 'html' ? splitIntoParts(htmlToText(raw)) : textPages(raw), warning: null };
  }
  return { kind, pages: [], warning: `BoilerSpace cannot read this file type (${contentType || fileName || 'unknown'}).` };
}
