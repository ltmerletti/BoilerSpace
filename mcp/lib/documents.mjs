import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { detectKind, extractText } from '../../extension/lib/extract.js';
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
    return bounded({ kind: 'pdf', pages, warning: sparse ? `${sparse} of ${pages.length} pages have little selectable text. Scanned pages and diagrams need visual reading, which this companion does not yet provide.` : null });
  } finally { await loading.destroy(); }
}

function bounded(result) {
  if (result.pages.length > 2000 || result.pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_TEXT_CHARS) throw new CompanionError('document-too-large', 'The extracted document exceeds its indexing limits.');
  if (!result.pages.some(page => page.text.trim())) throw new CompanionError('unreadable-document', result.warning || 'The document has no readable text.');
  return result;
}
