// POTION uses a weighted token table, mean pooling and L2 normalization.
// Quantized rows stay compressed in memory; only the pooled vector is expanded.
export function discussionEncoder(tokenizer, buffer, { unknownId = 1, maxTokens = 512 } = {}) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 10) throw new Error('Invalid embedding table.');
  const headerBytes = Number(new DataView(buffer).getBigUint64(0, true));
  if (!Number.isSafeInteger(headerBytes) || headerBytes < 2 || headerBytes > 65536 || headerBytes + 8 > buffer.byteLength) throw new Error('Invalid embedding header.');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes)));
  const info = header.embeddings;
  if (!info || !['I8', 'F16'].includes(info.dtype) || info.shape?.length !== 2 || !info.shape.every(n => Number.isInteger(n) && n > 0)) throw new Error('Unsupported embedding table.');
  const [vocabulary, dimensions] = info.shape;
  if (dimensions > 1024 || vocabulary > 100000) throw new Error('Embedding table exceeds supported dimensions.');
  const view = (tensor, width, Type) => {
    const [start, end] = tensor.data_offsets ?? [];
    const count = tensor.shape.reduce((a, b) => a * b, 1), offset = 8 + headerBytes + start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end - start !== count * width || offset % width || 8 + headerBytes + end > buffer.byteLength) throw new Error('Invalid embedding offsets.');
    return new Type(buffer, offset, count);
  };
  const values = view(info, info.dtype === 'I8' ? 1 : 2, info.dtype === 'I8' ? Int8Array : Uint16Array);
  let scales = null, half = null;
  if (info.dtype === 'I8') {
    if (header.scales?.dtype !== 'F32' || header.scales.shape?.length !== 1 || header.scales.shape[0] !== vocabulary) throw new Error('Invalid embedding scales.');
    scales = view(header.scales, 4, Float32Array);
    if (scales.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid embedding scale.');
  } else {
    half = Float32Array.from({ length: 65536 }, (_, bits) => {
      const sign = bits & 32768 ? -1 : 1, exponent = bits >>> 10 & 31, fraction = bits & 1023;
      return exponent === 0 ? sign * fraction * 2 ** -24 : exponent === 31 ? (fraction ? NaN : sign * Infinity) : sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
    });
  }
  return { dimensions, weightBytes: buffer.byteLength, encode(text) {
    const ids = tokenizer.encode(String(text).slice(0, 20000), { add_special_tokens: false }).ids.slice(0, maxTokens);
    const pooled = new Float64Array(dimensions);
    for (const id of ids) {
      if (id === unknownId) continue;
      if (!Number.isInteger(id) || id < 0 || id >= vocabulary) throw new Error('Token outside embedding vocabulary.');
      const offset = id * dimensions;
      if (scales) for (let j = 0; j < dimensions; j++) pooled[j] += values[offset + j] * scales[id];
      else for (let j = 0; j < dimensions; j++) pooled[j] += half[values[offset + j]];
    }
    const norm = Math.hypot(...pooled);
    if (!Number.isFinite(norm)) throw new Error('Nonfinite discussion embedding.');
    return Float32Array.from(pooled, value => norm ? value / norm : 0);
  } };
}
