import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { allowedPath, privateDirectory } from './config.mjs';
import { CompanionError } from './errors.mjs';

const DOWNLOAD_TIMEOUT_MS = 120000;
const DOWNLOAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function downloadName(value) {
  // Content-Disposition and course titles are untrusted, including Windows paths.
  const name = String(value ?? '').split(/[/\\]/).at(-1).replace(/[^a-zA-Z0-9._() -]/g, '_').slice(-180).replace(/^[. ]+|[. ]+$/g, '');
  return name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? name : 'course-file';
}

export async function downloadCourseFile(service, { sourceId }) {
  const { database, session } = service;
  const source = database.source(sourceId);
  if (!source || source.kind !== 'file') throw new CompanionError('source-not-found', 'Choose a file sourceId returned by list_course_sources.');
  if (!source.metadata.fileUrl) throw new CompanionError('file-unavailable', 'This source has no downloadable Brightspace file. Inline text can be read with read_document; external links stay on their original sites.');
  allowedPath(source.metadata.fileUrl);
  if (!session.directory) throw new CompanionError('data-directory-required', 'Downloads require the companion data directory.');

  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const file = await (await session.client(signal)).getFile(source.metadata.fileUrl);
  signal.throwIfAborted();
  if (/text\/html/i.test(file.contentType) && /<title[^>]*>[^<]*(?:sign.?in|log.?in)|type=["']password["']/i.test(new TextDecoder().decode(file.bytes.subarray(0, 8000)))) {
    throw new CompanionError('sign-in-required', 'Brightspace returned a login page instead of a course download. Run login again.');
  }
  if (database.source(source.id)?.revision !== source.revision) throw new CompanionError('source-changed', 'The source changed during download. List current course sources and retry.');
  await session.save();

  const id = randomUUID();
  const root = await privateDirectory(path.join(session.directory, 'downloads'));
  const directory = path.join(root, id);
  await mkdir(directory, { mode: 0o700 });
  try {
    const fileName = downloadName(file.fileName || source.title);
    const localPath = path.join(directory, fileName);
    await writeFile(localPath, file.bytes, { flag: 'wx', mode: 0o600 });
    const result = { id, sourceId: source.id, courseId: source.courseId, title: source.title, url: source.url, revision: source.revision,
      fileName, localPath, mimeType: file.contentType?.split(';')[0].trim() || 'application/octet-stream',
      byteLength: file.bytes.byteLength, sha256: sha256(file.bytes), downloadedAt: new Date().toISOString(), resourceUri: `boilerspace://downloads/${id}` };
    if (database.source(source.id)?.revision !== source.revision) throw new CompanionError('source-changed', 'The source changed during download. List current course sources and retry.');
    database.set(`download:${id}`, result);
    return result;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function readDownloadedFile(service, id) {
  if (!DOWNLOAD_ID.test(id)) throw new CompanionError('download-not-found', 'Choose a resourceUri returned by download_course_file.');
  const download = service.database.get(`download:${id}`);
  if (!download || !service.session.directory) throw new CompanionError('download-not-found', 'Download this course file before reading its resource.');
  const filePath = path.join(service.session.directory, 'downloads', id, downloadName(download.fileName));
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== download.byteLength) throw new CompanionError('download-changed', 'The saved download changed. Download the course file again.');
    const bytes = await handle.readFile();
    if (sha256(bytes) !== download.sha256) throw new CompanionError('download-changed', 'The saved download changed. Download the course file again.');
    return { uri: download.resourceUri, mimeType: download.mimeType, blob: bytes.toString('base64') };
  } catch (error) {
    if (error.code === 'ENOENT') throw new CompanionError('download-not-found', 'The saved download was removed. Download the course file again.');
    throw error;
  } finally { await handle?.close(); }
}
