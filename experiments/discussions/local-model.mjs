// Offline ONNX inference. Fetch public model assets before opening private discussions.
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import ort from '../retrieval/modern-js/node_modules/onnxruntime-node/dist/index.js';
import { AutoTokenizer, env } from '../retrieval/modern-js/node_modules/@huggingface/transformers/dist/transformers.node.mjs';

env.allowRemoteModels = false;
env.allowLocalModels = true;

export async function localModel(spec) {
  const directory = path.resolve(spec.directory);
  const tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  const filename = path.join(directory, spec.file);
  const session = await ort.InferenceSession.create(filename, {
    intraOpNumThreads: 4, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false,
  });
  return {
    modelBytes: statSync(filename).size + (existsSync(filename + '_data') ? statSync(filename + '_data').size : 0),
    outputs: session.outputNames,
    tokenize: (text, pair, options = {}) => tokenizer(text, { text_pair: pair, padding: true, truncation: true, max_length: spec.maxTokens ?? 512, ...options }),
    async run(tokens) {
      const feeds = Object.fromEntries(session.inputNames.map((name) => {
        const tensor = tokens[name];
        if (!tensor) throw new Error(`Tokenizer omitted required input ${name}.`);
        return [name, new ort.Tensor(tensor.type, tensor.data, tensor.dims)];
      }));
      return session.run(feeds);
    },
    async forward(text, pair = undefined, options = {}) {
      return this.run(await this.tokenize(text, pair, options));
    },
    async embed(text, prefix = '') {
      const result = await this.forward(prefix + text);
      const tensor = result.sentence_embedding;
      if (!tensor || tensor.dims.at(-1) !== spec.dimensions) throw new Error('Missing projected sentence embedding.');
      const norm = Math.hypot(...tensor.data);
      if (!norm || !Number.isFinite(norm)) throw new Error('Invalid embedding norm.');
      return Float32Array.from(tensor.data, (v) => v / norm);
    },
    close: () => session.release(),
  };
}

// Ettin's ONNX export contains the encoder only. Apply the published pooling/MLP head.
export function loadRerankerHead(directory) {
  const tensors = (file) => {
    const buffer = readFileSync(path.join(directory, file));
    const length = Number(buffer.readBigUInt64LE(0));
    const header = JSON.parse(buffer.subarray(8, 8 + length));
    return Object.fromEntries(Object.entries(header).filter(([key]) => key !== '__metadata__').map(([key, value]) => {
      if (value.dtype !== 'F32') throw new Error('Reranker head requires float32 tensors.');
      const bytes = buffer.subarray(8 + length + value.data_offsets[0], 8 + length + value.data_offsets[1]);
      return [key, { shape: value.shape, values: Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4)) }];
    }));
  };
  const dense = tensors('2_Dense/model.safetensors')['linear.weight'];
  const norm = tensors('3_LayerNorm/model.safetensors');
  const output = tensors('4_Dense/model.safetensors');
  // Abramowitz-Stegun erf approximation; maximum absolute error is below 1.5e-7.
  const erf = (x) => {
    const sign = x < 0 ? -1 : 1, value = Math.abs(x), t = 1 / (1 + 0.3275911 * value);
    return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-value * value));
  };
  return (hidden) => {
    const dimensions = dense.shape[1], projected = new Float64Array(dense.shape[0]);
    for (let i = 0; i < projected.length; i++) {
      let value = 0;
      for (let j = 0; j < dimensions; j++) value += hidden[j] * dense.values[i * dimensions + j];
      projected[i] = value * 0.5 * (1 + erf(value / Math.SQRT2));
    }
    const mean = projected.reduce((sum, v) => sum + v, 0) / projected.length;
    const variance = projected.reduce((sum, v) => sum + (v - mean) ** 2, 0) / projected.length;
    let score = output['linear.bias'].values[0];
    for (let i = 0; i < projected.length; i++) {
      const value = (projected[i] - mean) / Math.sqrt(variance + 1e-5) * norm['norm.weight'].values[i] + norm['norm.bias'].values[i];
      score += value * output['linear.weight'].values[i];
    }
    if (!Number.isFinite(score)) throw new Error('Invalid reranker score.');
    return score;
  };
}
