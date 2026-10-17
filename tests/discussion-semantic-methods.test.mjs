import test from 'node:test';
import assert from 'node:assert/strict';
import { maxSim, candidateUnion, rerankCandidates, tableEncoder } from '../experiments/discussions/semantic-methods.mjs';

const entry = id => ({ id, chunkIndex: 0 });
test('semantic candidates survive union even when absent from lexical results', () => {
  const lexical = [entry('keyword'), entry('shared')], semantic = [entry('shared'), entry('paraphrase')];
  const pool = candidateUnion([lexical, semantic]);
  assert.deepEqual(pool.map(e => e.id), ['keyword', 'shared', 'paraphrase']);
  const result = rerankCandidates(lexical, pool, e => e.id === 'paraphrase' ? 10 : 0, { originalWeight: 0 });
  assert.equal(result[0].id, 'paraphrase');
  assert.throws(() => candidateUnion([lexical], 0));
});
test('MaxSim matches each query token independently and does not sum every document token', () => {
  assert.equal(maxSim([1, 0, 0, 1], [1, 0, 0, 1, -1, 0], 2), 2);
  assert.equal(maxSim([1, 0, 1, 0], [0.5, 0.5], 2), 1);
  assert.throws(() => maxSim([1, 0], [1], 2));
  assert.throws(() => maxSim([NaN, 0], [1, 0], 2));
});
test('static table pooling excludes unknowns, normalizes, and uses no special tokens', () => {
  let header = JSON.stringify({ embeddings: { dtype: 'F32', shape: [3, 2], data_offsets: [0, 24] } });
  header = header.padEnd(Math.ceil(header.length / 8) * 8, ' ');
  const buffer = new ArrayBuffer(8 + header.length + 24);
  new DataView(buffer).setBigUint64(0, BigInt(header.length), true);
  new Uint8Array(buffer, 8, header.length).set(new TextEncoder().encode(header));
  new Float32Array(buffer, 8 + header.length).set([100, 100, 1, 0, 0, 1]);
  const encoder = tableEncoder({ encode(text, options) { assert.equal(options.add_special_tokens, false); return { ids: text ? [0, 1, 2] : [] }; } }, buffer, { unknownId: 0 });
  const vector = encoder.encode('public test');
  assert.ok(Math.abs(vector[0] - Math.SQRT1_2) < 1e-7);
  assert.ok(Math.abs(vector[1] - Math.SQRT1_2) < 1e-7);
  assert.deepEqual([...encoder.encode('')], [0, 0]);
  assert.throws(() => tableEncoder({ encode: () => ({ ids: [4] }) }, buffer).encode('bad'));
});
