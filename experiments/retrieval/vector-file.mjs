import { readFileSync } from 'node:fs';

// Workers write little-endian float32 rows without padding or model-specific headers.
export function readVectorFile(filename, count, dimensions) {
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error('Invalid vector shape.');
  }
  const bytes = readFileSync(filename);
  if (bytes.length !== count * dimensions * 4) throw new Error('Vector file dimensions do not match the dataset.');
  const values = new Float32Array(count * dimensions);
  for (let i = 0; i < values.length; i++) values[i] = bytes.readFloatLE(i * 4);
  if (!values.every(Number.isFinite)) throw new Error('Non-finite embedding value.');
  return Array.from({ length: count }, (_, i) => values.subarray(i * dimensions, (i + 1) * dimensions));
}
