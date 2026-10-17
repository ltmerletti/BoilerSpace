// SSE inference uses a token-vector table, mean pooling, and a per-coordinate transform.
// Float32 views share the safetensors buffer; loading does not duplicate the weight matrix.
export function staticEncoder(tokenizer, buffer) {
  const headerBytes = Number(new DataView(buffer).getBigUint64(0, true));
  if (!Number.isSafeInteger(headerBytes) || headerBytes + 8 > buffer.byteLength) throw new Error('Invalid tensor header.');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes)));
  const tensor = (name) => {
    const info = header[name];
    if (!info || !['F32', 'F16'].includes(info.dtype)) throw new Error(`Missing supported tensor ${name}.`);
    const [start, end] = info.data_offsets, count = info.shape.reduce((a, b) => a * b, 1);
    const width = info.dtype === 'F16' ? 2 : 4;
    if (start < 0 || end < start || end - start !== count * width || end + 8 + headerBytes > buffer.byteLength) throw new Error('Invalid tensor shape or offsets.');
    return { shape: info.shape, dtype: info.dtype, data: info.dtype === 'F16' ? new Uint16Array(buffer, 8 + headerBytes + start, count) : new Float32Array(buffer, 8 + headerBytes + start, count) };
  };
  const embedding = tensor('embedding.weight'), alpha = tensor('dyt.alpha'), beta = tensor('dyt.beta'), bias = tensor('dyt.bias');
  const [vocabulary, dimensions] = embedding.shape;
  if (embedding.shape.length !== 2 || [alpha, beta, bias].some((t) => t.data.length !== dimensions || t.dtype !== 'F32')) throw new Error('Incompatible static model dimensions.');
  const halfValues = embedding.dtype === 'F16' ? Float32Array.from({ length: 65536 }, (_, bits) => {
    const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 31, fraction = bits & 1023;
    return exponent === 0 ? sign * fraction * 2 ** -24 : exponent === 31 ? (fraction ? NaN : sign * Infinity) : sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
  }) : null;
  return {
    dimensions, weightBytes: buffer.byteLength,
    encode(text) {
      const { ids } = tokenizer.encode(text, { add_special_tokens: false });
      if (!ids.length) throw new Error('Cannot embed text without tokens.');
      const pooled = new Float64Array(dimensions);
      for (const id of ids) {
        if (!Number.isInteger(id) || id < 0 || id >= vocabulary) throw new Error('Token is outside the embedding vocabulary.');
        const offset = id * dimensions;
        for (let j = 0; j < dimensions; j++) pooled[j] += halfValues ? halfValues[embedding.data[offset + j]] : embedding.data[offset + j];
      }
      for (let j = 0; j < dimensions; j++) pooled[j] = beta.data[j] * Math.tanh(alpha.data[j] * pooled[j] / ids.length + bias.data[j]);
      const norm = Math.hypot(...pooled);
      if (!norm || !Number.isFinite(norm)) throw new Error('Invalid static embedding.');
      return Float32Array.from(pooled, (v) => v / norm);
    },
  };
}
