import test from 'node:test';
import assert from 'node:assert/strict';
import { staticEncoder } from '../experiments/discussions/static-embedding.mjs';

function fixture(half = false) {
  const tensors = [
    ['embedding.weight', [2, 2], half ? 'F16' : 'F32', half ? [0x3c00, 0, 0, 0x3c00] : [1, 0, 0, 1]],
    ['dyt.alpha', [2], 'F32', [1, 1]], ['dyt.beta', [2], 'F32', [1, 1]], ['dyt.bias', [2], 'F32', [0, 0]],
  ];
  let through = 0;
  const header = Object.fromEntries(tensors.map(([name, shape, dtype, values]) => {
    const start = through; through += values.length * (dtype === 'F16' ? 2 : 4);
    return [name, { dtype, shape, data_offsets: [start, through] }];
  }));
  const json = JSON.stringify(header), encoded = new TextEncoder().encode(json + ' '.repeat((8 - json.length % 8) % 8));
  const buffer = new ArrayBuffer(8 + encoded.length + through), view = new DataView(buffer);
  view.setBigUint64(0, BigInt(encoded.length), true);
  new Uint8Array(buffer, 8, encoded.length).set(encoded);
  for (const [name, , dtype, values] of tensors) for (const [i, value] of values.entries()) {
    const offset = 8 + encoded.length + header[name].data_offsets[0] + i * (dtype === 'F16' ? 2 : 4);
    if (dtype === 'F16') view.setUint16(offset, value, true);
    else view.setFloat32(offset, value, true);
  }
  return { buffer, embeddingOffset: 8 + encoded.length };
}

test('static inference pools tokens and handles float16 storage without expanding the matrix', () => {
  const tokenizer = { encode: () => ({ ids: [0, 1] }) };
  for (const half of [false, true]) {
    const model = staticEncoder(tokenizer, fixture(half).buffer), vector = model.encode('Example');
    assert.equal(model.dimensions, 2);
    assert.ok(Math.abs(vector[0] - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(vector[1] - Math.SQRT1_2) < 1e-6);
  }
});

test('static weights share the original buffer instead of copying the resident matrix', () => {
  const { buffer, embeddingOffset } = fixture();
  const model = staticEncoder({ encode: () => ({ ids: [0] }) }, buffer);
  assert.deepEqual([...model.encode('Example')], [1, 0]);
  new DataView(buffer).setFloat32(embeddingOffset + 4, 1, true);
  assert.ok(model.encode('Example')[1] > 0.7);
});

test('static inference rejects invalid token IDs and malformed weights', () => {
  const model = staticEncoder({ encode: () => ({ ids: [2] }) }, fixture().buffer);
  assert.throws(() => model.encode('Example'), /outside the embedding vocabulary/);
  assert.throws(() => staticEncoder({}, new ArrayBuffer(16)), /Invalid tensor|JSON/);
});
