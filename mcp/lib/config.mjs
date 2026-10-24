import { mkdir, lstat, chmod, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanionError } from './errors.mjs';

export const ORIGIN = 'https://purdue.brightspace.com';
export const MAX_FILE_BYTES = 200_000_000;
export const MAX_TEXT_CHARS = 8_000_000;

export function dataDirectory(value = process.env.BOILERSPACE_DATA_DIR) {
  return path.resolve(value || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'boilerspace-companion'));
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CompanionError('unsafe-directory', 'The data directory must be a real directory, not a symbolic link.');
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  return directory;
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

// Agents select known course/file identifiers, never arbitrary authenticated URLs.
export function allowedPath(value) {
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || /%2f|%5c/i.test(url.pathname)) throw new CompanionError('blocked-request', 'Only Purdue Brightspace course requests are allowed.');
  const pathname = url.pathname;
  const allowed = pathname === '/d2l/api/versions/'
    || /^\/d2l\/api\/lp\/[\d.]+\/(?:users\/whoami|enrollments\/myenrollments\/|courses\/\d+\/?|orgstructure\/\d+\/parents|auth\/xsrf-tokens)$/.test(pathname)
    || /^\/d2l\/api\/le\/[\d.]+\/\d+\/(?:dropbox\/folders\/|quizzes\/|quizzes\/\d+\/(?:attempts\/|attempts\/\d+\/questions\/|questions\/)|news\/|content\/toc|content\/topics\/\d+(?:\/file)?|calendar\/events\/myEvents\/|overview(?:\/attachment)?)$/.test(pathname)
    || /^\/d2l\/home\/\d+$/.test(pathname) || /^\/d2l\/le\/content\/\d+\/Home$/.test(pathname)
    || /^\/d2l\/lms\/quizzing\/user\/(?:quiz_submissions(?:_attempt)?\.d2l|attempt\/quiz_review\.d2l)$/.test(pathname)
    || pathname === '/d2l/lp/auth/oauth2/token'
    || /^\/content\//.test(pathname);
  if (!allowed) throw new CompanionError('blocked-request', 'This endpoint is outside the companion’s read-only course access.');
  return url;
}
