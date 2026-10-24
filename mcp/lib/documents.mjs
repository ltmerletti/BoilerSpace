import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { detectKind, extractText, slidePictures } from '../../extension/lib/extract.js';
import { MAX_TEXT_CHARS, MAX_FILE_BYTES } from './config.mjs';
import { CompanionError } from './errors.mjs';

const require = createRequire(import.meta.url);
const pdfRoot = new URL('./', pathToFileURL(require.resolve('pdfjs-dist/package.json')));

export async function extractDocument(file) {
  const archiveOptions = { maxArchiveBytes: MAX_FILE_BYTES };
  if (detectKind(file.bytes, file.fileName, file.contentType, archiveOptions) !== 'pdf') return bounded(await extractText(file, archiveOptions));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({ data: new Uint8Array(file.bytes), isEvalSupported: false,
    wasmUrl: fileURLToPath(new URL('wasm/', pdfRoot)), cMapUrl: fileURLToPath(new URL('cmaps/', pdfRoot)), cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', pdfRoot)), useSystemFonts: false });
  try {
    const document = await loading.promise;
    if (document.numPages > 2000) throw new CompanionError('document-too-large', 'This PDF exceeds the 2,000-page reading limit.');
    const pages = [];
    let length = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('').trim();
      length += text.length;
      if (length > MAX_TEXT_CHARS) throw new CompanionError('document-too-large', 'The document exceeds the eight-million-character indexing limit.');
      pages.push({ page: number, label: `page ${number}`, text });
      page.cleanup();
    }
    const sparse = pages.filter(page => page.text.length < 40).length;
    return bounded({ kind: 'pdf', pages, warning: sparse ? `${sparse} of ${pages.length} pages have little selectable text. Use read_course_file with see_images and a page location to inspect scanned pages and diagrams with a vision-capable client.` : null });
  } finally { await loading.destroy(); }
}

function bounded(result) {
  if (result.pages.length > 2000 || result.pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_TEXT_CHARS) throw new CompanionError('document-too-large', 'The extracted document exceeds its indexing limits.');
  if (!result.pages.some(page => page.text.trim())) throw new CompanionError('unreadable-document', result.warning || 'The document has no readable text.');
  return result;
}

export async function documentImages(file, pageNumber) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const kind = detectKind(file.bytes, file.fileName, file.contentType, { maxArchiveBytes: MAX_FILE_BYTES });
  const image = async bytes => {
    const original = await loadImage(Buffer.from(bytes));
    const scale = Math.min(1, 1280 / Math.max(original.width, original.height));
    const canvas = createCanvas(Math.max(1, Math.round(original.width * scale)), Math.max(1, Math.round(original.height * scale)));
    canvas.getContext('2d').drawImage(original, 0, 0, canvas.width, canvas.height);
    return { mediaType: 'image/jpeg', data: (await canvas.encode('jpeg', 80)).toString('base64') };
  };
  if (kind === 'pptx') return { location: `slide ${pageNumber}`, images: await Promise.all(slidePictures(file.bytes, `slide ${pageNumber}`).map(picture => image(picture.bytes))) };
  if (kind !== 'pdf') return { images: [], note: 'This format has no supported page image reader.' };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({ data: new Uint8Array(file.bytes), isEvalSupported: false, useSystemFonts: false,
    wasmUrl: fileURLToPath(new URL('wasm/', pdfRoot)), cMapUrl: fileURLToPath(new URL('cmaps/', pdfRoot)), cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', pdfRoot)) });
  try {
    const document = await loading.promise;
    if (pageNumber > document.numPages || document.numPages > 2000) throw new CompanionError('page-not-found', 'That PDF page is outside the supported page range.');
    const page = await document.getPage(pageNumber), base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1280 / Math.max(base.width, base.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    const text = (await page.getTextContent()).items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('').trim();
    return { location: `page ${pageNumber}`, text, images: [{ mediaType: 'image/jpeg', data: (await canvas.encode('jpeg', 80)).toString('base64') }] };
  } finally { await loading.destroy(); }
}
