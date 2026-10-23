import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument } from '../lib/documents.mjs';
import { publicError } from '../lib/errors.mjs';

try { parentPort.postMessage({ data: await extractDocument(workerData) }); }
catch (error) { parentPort.postMessage({ error: publicError(error) }); }
