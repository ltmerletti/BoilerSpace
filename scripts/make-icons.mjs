// Draws the toolbar icon (a black page with planner rules, today's in gold) as PNGs with no dependencies.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLACK = [0, 0, 0, 255];
const GOLD = [218, 170, 0, 255];
const PAPER = [235, 237, 239, 255];
const CLEAR = [0, 0, 0, 0];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) Buffer.from(pixel(x + 0.5, y + 0.5)).copy(row, 1 + x * 4);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function icon(size) {
  const s = (v) => v * size;
  const radius = s(0.2);
  return png(size, (x, y) => {
    const dx = Math.max(radius - x, x - (size - radius), 0);
    const dy = Math.max(radius - y, y - (size - radius), 0);
    if (dx * dx + dy * dy > radius * radius) return CLEAR;
    const inX = x > s(0.22) && x < s(0.78);
    const bar = (top, height) => inX && y > s(top) && y < s(top) + Math.max(s(height), 1.2);
    if (bar(0.26, 0.08)) return PAPER;
    if (bar(0.46, 0.12)) return GOLD;
    if (bar(0.68, 0.08)) return PAPER;
    return BLACK;
  });
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../extension/icons/icon${size}.png`, import.meta.url), icon(size));
}
