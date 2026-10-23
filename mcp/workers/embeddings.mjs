import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { Tokenizer } from '../../extension/vendor/tokenizers/tokenizers.mjs';
import { discussionEncoder } from '../../extension/lib/discussion-embedding.js';

export const MODEL = 'potion-i8-796f9def';
let encoder;
try {
  const [table, tokenizer] = await Promise.all([
    readFile(new URL('../../extension/vendor/potion/model-i8.safetensors', import.meta.url)),
    readFile(new URL('../../extension/vendor/potion/tokenizer.json', import.meta.url)),
  ]);
  const hash = value => createHash('sha256').update(value).digest('hex');
  if (hash(table) !== '796f9def7a06baabb842ed18efbce1331f3744a0a77dc5404e82ac8e5f41805e' || hash(tokenizer) !== '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18') throw new Error('Model integrity check failed');
  encoder = discussionEncoder(new Tokenizer(JSON.parse(tokenizer), {}), table.buffer.slice(table.byteOffset, table.byteOffset + table.byteLength));
  parentPort.postMessage({ ready: true });
} catch { parentPort.postMessage({ error: true }); }

parentPort.on('message', ({ id, texts }) => {
  try {
    if (!encoder) throw new Error('Encoder unavailable');
    const vectors = texts.map(text => encoder.encode(text));
    parentPort.postMessage({ id, vectors }, vectors.map(vector => vector.buffer));
  } catch { parentPort.postMessage({ id, error: true }); }
});
