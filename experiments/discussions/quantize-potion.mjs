// Derive deterministic row-wise int8 and float16 tables from the pinned public weights.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = readFileSync('.verify-tmp/retrieval-models/potion-retrieval-32M/model.safetensors');
if (createHash('sha256').update(source).digest('hex') !== '07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0') throw new Error('Published POTION weights changed.');
const bytes = Number(source.readBigUInt64LE(0)), info = JSON.parse(source.subarray(8, 8 + bytes)).embeddings;
if (info.dtype !== 'F32') throw new Error('Expected float32 source.');
const [rows, dims] = info.shape, values = new Float32Array(source.buffer, source.byteOffset + 8 + bytes + info.data_offsets[0], rows * dims);
const output = '.verify-tmp/discussion-retrieval/production'; mkdirSync(output, { recursive: true });
const floats = new Float32Array(1), bits = new Uint32Array(floats.buffer);
function toHalf(value) {
  floats[0] = value;
  const b = bits[0], sign = b >>> 16 & 32768, e = (b >>> 23 & 255) - 127 + 15, m = b & 8388607;
  if (e >= 31) return sign | 31744;
  if (e <= 0) return e < -10 ? sign : sign | ((m | 8388608) + (1 << (13 - e)) >>> (14 - e));
  return sign | (e << 10) + ((m + 4096) >>> 13);
}
for (const dtype of ['I8', 'F16']) {
  const encoded = dtype === 'I8' ? new Int8Array(values.length) : new Uint16Array(values.length), scales = new Float32Array(rows);
  for (let row = 0; row < rows; row++) {
    let max = 0; for (let j = 0; j < dims; j++) max = Math.max(max, Math.abs(values[row * dims + j]));
    scales[row] = max / 127;
    for (let j = 0; j < dims; j++) encoded[row * dims + j] = dtype === 'I8' ? scales[row] ? Math.max(-127, Math.min(127, Math.round(values[row * dims + j] / scales[row]))) : 0 : toHalf(values[row * dims + j]);
  }
  const header = { embeddings: { dtype, shape: info.shape, data_offsets: [0, encoded.byteLength] } };
  if (dtype === 'I8') header.scales = { dtype: 'F32', shape: [rows], data_offsets: [encoded.byteLength, encoded.byteLength + scales.byteLength] };
  const json = JSON.stringify(header), length = Math.ceil(Buffer.byteLength(json) / 8) * 8, prefix = Buffer.alloc(8 + length, ' ');
  prefix.writeBigUInt64LE(BigInt(length)); prefix.write(json, 8);
  const result = Buffer.concat([prefix, Buffer.from(encoded.buffer), ...(dtype === 'I8' ? [Buffer.from(scales.buffer)] : [])]);
  const file = `${output}/potion-${dtype.toLowerCase()}.safetensors`; writeFileSync(file, result);
  console.log(JSON.stringify({ file, bytes: result.length, sha256: createHash('sha256').update(result).digest('hex') }));
}
