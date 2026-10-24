import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument, documentImages } from '../lib/documents.mjs';
import { publicError } from '../lib/errors.mjs';

try { parentPort.postMessage({ data: workerData.operation === 'images' ? await documentImages(workerData, workerData.pageNumber) : await extractDocument(workerData) }); }
catch (error) { parentPort.postMessage({ error: publicError(error) }); }
