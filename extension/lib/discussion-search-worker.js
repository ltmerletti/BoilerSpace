import { Tokenizer } from '../vendor/tokenizers/tokenizers.mjs';
import { discussionEncoder } from './discussion-embedding.js';
import { discussionIndex, discussionContext } from './discussion-ranking.js';

const MODEL_SHA256 = '796f9def7a06baabb842ed18efbce1331f3744a0a77dc5404e82ac8e5f41805e';
let encoderPromise, corpusHash, index, vectors;

async function loadEncoder() {
  if (!encoderPromise) encoderPromise = (async () => {
    const [tableResponse, tokenizerResponse] = await Promise.all([
      fetch(new URL('../vendor/potion/model-i8.safetensors', import.meta.url)),
      fetch(new URL('../vendor/potion/tokenizer.json', import.meta.url)),
    ]);
    if (!tableResponse.ok || !tokenizerResponse.ok) throw new Error('Bundled discussion model is unavailable.');
    const table = await tableResponse.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', table))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== MODEL_SHA256) throw new Error('Discussion model integrity check failed.');
    const tokenizerBytes = await tokenizerResponse.arrayBuffer();
    const tokenizerHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', tokenizerBytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (tokenizerHash !== '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18') throw new Error('Discussion tokenizer integrity check failed.');
    return discussionEncoder(new Tokenizer(JSON.parse(new TextDecoder().decode(tokenizerBytes)), {}), table);
  })();
  return encoderPromise;
}

async function retrieve({ hash, entries, query, scope }) {
  const encoder = await loadEncoder();
  let indexed = false;
  if (hash !== corpusHash) {
    if (!Array.isArray(entries)) throw new Error('Discussion corpus is unavailable.');
    const nextIndex = discussionIndex(entries), nextVectors = new Float32Array(entries.length * encoder.dimensions);
    for (let i = 0; i < entries.length; i++) nextVectors.set(encoder.encode(`${entries[i].title}\n${entries[i].text}`), i * encoder.dimensions);
    index = nextIndex; vectors = nextVectors; corpusHash = hash; indexed = true;
  }
  const start = performance.now();
  const results = discussionContext(index.rank(query, scope, { encoder, vectors }));
  return { results, method: 'potion-i8-bm25', indexed, queryMs: performance.now() - start };
}

// Serialize corpus replacement and queries so concurrent requests cannot mix snapshots.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, ...request } }) => {
  queue = queue.then(async () => {
    try { self.postMessage({ id, result: await retrieve(request) }); }
    catch (error) { self.postMessage({ id, error: error.message }); }
  });
};
