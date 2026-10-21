// Text only: no objects, pictures, field instructions or external resources are opened.
// Group/control syntax: https://learn.microsoft.com/en-us/previous-versions/office/developer/office2000/aa140284(v=office.10)

const OMIT = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'filetbl', 'info', 'generator',
  'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'xmlnstbl',
  'pict', 'object', 'objdata', 'nonshppict', 'shppict', 'shp',
  'fldinst', 'datafield', 'formfield', 'bkmkstart', 'bkmkend',
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'annotation', 'atnauthor', 'atnid', 'pn', 'pntext', 'xe', 'tc', 'private',
]);
const CHARACTERS = {
  par: '\n', line: '\n', page: '\n\n', sect: '\n\n', row: '\n', nestrow: '\n',
  tab: '\t', cell: '\t', nestcell: '\t', bullet: '•',
  emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  enspace: ' ', emspace: ' ', qmspace: ' ',
};
const CODE_PAGES = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 65001: 'utf-8' };
const FONT_CHARSETS = { 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
const letter = code => code >= 65 && code <= 90 || code >= 97 && code <= 122;
const digit = code => code >= 48 && code <= 57;
const invalid = () => new Error('This RTF file is malformed or incomplete.');

export function rtfToText(bytes) {
  if (bytes.length > 25_000_000) throw new Error('This RTF exceeds the 25 MB reading limit.');
  // One byte per character preserves the byte count used by \\bin and legacy encodings.
  let input = '';
  for (let i = 0; i < bytes.length; i += 8192) input += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const start = /^(?:\xef\xbb\xbf)?\s*(?=\{\\rtf\d)/.exec(input)?.[0].length;
  if (start === undefined) throw new Error('This file does not contain a valid RTF header.');
  const stack = [], output = [], pending = [], decoders = new Map(), fonts = new Map();
  let state = { skip: false, hidden: false, uc: 1, codePage: 1252, font: null, fontTable: false, starred: false, upr: false, children: 0 };
  let fallback = 0, pictures = false, closed = false, activeDecoder = null;
  const decoder = () => {
    const page = fonts.get(state.font) ?? state.codePage;
    if (!decoders.has(page)) {
      try { decoders.set(page, new TextDecoder(CODE_PAGES[page] ?? (page === 874 ? 'windows-874' : `windows-${page}`), { fatal: true })); }
      catch { throw new Error(`This RTF uses an unsupported character encoding (${page}).`); }
    }
    return decoders.get(page);
  };
  const flush = (final = true) => {
    if (!pending.length && !activeDecoder) return;
    const current = activeDecoder ?? decoder();
    try { output.push(current.decode(new Uint8Array(pending), { stream: !final })); }
    catch { throw new Error('This RTF contains text that could not be decoded.'); }
    activeDecoder = final ? null : current;
    pending.length = 0;
  };
  const emit = text => {
    if (fallback) { fallback--; return; }
    if (!state.skip && !state.hidden) { flush(); output.push(text); }
  };
  const byte = value => {
    if (fallback) { fallback--; return; }
    if (!state.skip && !state.hidden) pending.push(value);
    if (pending.length >= 8192) flush(false);
  };
  for (let i = start; i < input.length;) {
    const char = input[i++];
    if (closed) {
      if (!/\s/.test(char)) throw invalid();
      continue;
    }
    if (char === '{') {
      flush(); fallback = 0;
      if (stack.length >= 256) throw new Error('This RTF has too many nested groups.');
      state.children++;
      stack.push(state);
      // \\upr carries ANSI and Unicode alternatives. Read the Unicode child only.
      state = { ...state, skip: state.skip || state.upr && state.children === 1, starred: false, upr: false, children: 0 };
    } else if (char === '}') {
      flush(); fallback = 0;
      if (!stack.length) throw invalid();
      state = stack.pop();
      if (!stack.length) closed = true;
    } else if (char === '\\') {
      if (i >= input.length) throw invalid();
      const symbol = input[i++];
      if (!letter(symbol.charCodeAt(0))) {
        if (symbol === "'") {
          const hex = input.slice(i, i + 2);
          if (!/^[0-9a-f]{2}$/i.test(hex)) throw invalid();
          i += 2; byte(parseInt(hex, 16));
        } else if (symbol === '*') {
          flush(); state.starred = true;
        } else if (symbol === '\\' || symbol === '{' || symbol === '}') byte(symbol.charCodeAt(0));
        else if (symbol === '~') emit('\u00a0');
        else if (symbol === '_') emit('\u2011');
        else if (symbol === '-') emit('\u00ad');
        else if (symbol === '\n' || symbol === '\r') emit('\n');
        continue;
      }
      const wordStart = i - 1;
      while (i < input.length && letter(input.charCodeAt(i))) i++;
      const word = input.slice(wordStart, i);
      const numberStart = i;
      if (input[i] === '-') i++;
      while (i < input.length && digit(input.charCodeAt(i))) i++;
      const raw = input.slice(numberStart, i);
      const value = raw && raw !== '-' ? Number(raw) : null;
      if (input[i] === ' ') i++;
      flush();
      if (word === 'bin') {
        if (!Number.isSafeInteger(value) || value < 0 || value > input.length - i) throw invalid();
        i += value;
        if (fallback) fallback--;
        continue;
      }
      if (fallback) { fallback--; continue; }
      if (state.starred) {
        if (word !== 'ud' || !stack.at(-1)?.upr) state.skip = true;
        state.starred = false;
      }
      if (word === 'pict' || word === 'object' || word === 'shp') pictures = true;
      if (word === 'fonttbl') state.fontTable = true;
      if (OMIT.has(word)) state.skip = true;
      if (word === 'upr') { state.upr = true; state.children = 0; }
      if (word === 'f') state.font = value;
      if (state.fontTable && state.font !== null) {
        if (word === 'fcharset' && FONT_CHARSETS[value]) fonts.set(state.font, FONT_CHARSETS[value]);
        if (word === 'cpg') fonts.set(state.font, value);
      }
      if (state.skip) continue;
      if (word === 'ansicpg') state.codePage = value;
      else if (word === 'mac') state.codePage = 10000;
      else if (word === 'uc') {
        if (!Number.isInteger(value) || value < 0 || value > 32767) throw invalid();
        state.uc = value;
      } else if (word === 'u') {
        if (!Number.isInteger(value) || value < -32768 || value > 65535) throw invalid();
        if (!state.hidden) output.push(String.fromCharCode(value & 0xffff));
        fallback = state.uc;
      } else if (word === 'v') state.hidden = value !== 0;
      else if (word === 'plain') { state.hidden = false; state.font = null; }
      else if (Object.hasOwn(CHARACTERS, word)) emit(CHARACTERS[word]);
    } else if (char !== '\r' && char !== '\n') byte(char.charCodeAt(0));
  }
  flush();
  if (stack.length || !closed) throw invalid();
  return { text: output.join(''), pictures };
}
