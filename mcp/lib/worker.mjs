import { Worker } from 'node:worker_threads';
import { CompanionError } from './errors.mjs';

export function workerRequest(url, data, { signal, timeout = 30000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Parser diagnostics must never enter the MCP protocol's stdout stream.
    const worker = new Worker(url, { workerData: data, execArgv: [], stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    const timer = setTimeout(() => finish(reject, new CompanionError('document-timeout', 'Reading this document exceeded its 30-second time limit.')), timeout);
    worker.on('message', result => result.error ? finish(reject, new CompanionError(result.error.code, result.error.message)) : finish(resolve, result.data));
    worker.on('error', () => finish(reject, new CompanionError('worker-failed', 'The document reader stopped. Other indexed documents remain available.')));
    worker.on('exit', () => { if (!settled) finish(reject, new CompanionError('worker-failed', 'The document reader exited without returning a result.')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
