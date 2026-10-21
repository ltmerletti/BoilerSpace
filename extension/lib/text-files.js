// Text stays as written, including code indentation and tab-separated columns.
export function decodeText(bytes, contentType = '') {
  if (bytes.length > 10_000_000) throw new Error('This text file exceeds the 10 MB reading limit.');
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : null;
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  let decoder;
  try { decoder = new TextDecoder(bom || charset || 'utf-8', { fatal: true }); }
  catch { throw new Error('This text file uses an unsupported character encoding.'); }
  let text;
  try { text = decoder.decode(bytes); }
  catch { throw new Error('This file could not be decoded as text.'); }
  // eslint-disable-next-line no-control-regex -- Reject binary control bytes in files advertised as text.
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('This file contains binary data, not readable text.');
  return text.replace(/\r\n?/g, '\n');
}

export function textPages(text) {
  const pages = [], lines = text.split('\n');
  let start = 0, size = 0;
  const add = end => {
    const text = lines.slice(start, end).join('\n');
    if (text.trim()) pages.push({ page: pages.length + 1, label: `lines ${start + 1}–${end}`, text });
    start = end; size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    if (size && size + lines[i].length > 3500) add(i);
    size += lines[i].length + 1;
  }
  add(lines.length);
  return pages;
}

export function notebookPages(text) {
  let notebook;
  try { notebook = JSON.parse(text); }
  catch { throw new Error('This notebook is not valid JSON.'); }
  if (notebook?.nbformat !== 4 || !Array.isArray(notebook.cells)) throw new Error('This file is not a supported Jupyter notebook (version 4).');
  if (notebook.cells.length > 10_000) throw new Error('This notebook contains too many cells.');
  const pages = [];
  let outputs = false;
  notebook.cells.forEach((cell, i) => {
    if (!cell || !['markdown', 'code', 'raw'].includes(cell.cell_type)) throw new Error(`Notebook cell ${i + 1} has an invalid type.`);
    const source = Array.isArray(cell.source) && cell.source.every(line => typeof line === 'string') ? cell.source.join('') : cell.source;
    if (typeof source !== 'string') throw new Error(`Notebook cell ${i + 1} has invalid source text.`);
    outputs ||= Boolean(cell.outputs?.length || Object.keys(cell.attachments ?? {}).length);
    if (source.trim()) pages.push({ page: i + 1, label: `cell ${i + 1}`, text: source.replace(/\r\n?/g, '\n') });
  });
  return { pages, warning: outputs ? 'Saved notebook outputs and attachments were skipped; only cell source text was read.' : null };
}
