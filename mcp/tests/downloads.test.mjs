import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CookieJar } from 'tough-cookie';
import { CourseDatabase } from '../lib/database.mjs';
import { CourseService, sourcesFromSnapshot } from '../lib/service.mjs';
import { readDownloadedFile } from '../lib/downloads.mjs';
import { toolRegistry, callTool } from '../lib/tools.mjs';
import { createServer } from '../server.mjs';
import { BrightspaceSession } from '../lib/session.mjs';
import { ORIGIN, atomicJson } from '../lib/config.mjs';
import { seed, noSemantics } from './fixtures.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'boilerspace-downloads-'));
  const database = new CourseDatabase(':memory:');
  const snapshot = seed(database);
  const requests = [];
  let saves = 0;
  const session = { directory, client: async () => ({ getFile: async url => {
    requests.push(url);
    return { bytes: Buffer.from([0, 255, 80, requests.length]), fileName: '../../C:\\notes\\experiment.bin', contentType: 'application/octet-stream' };
  } }), save: async () => { saves++; } };
  const service = new CourseService(database, session, { retrieval: noSemantics, extract: async () => { throw new Error('Downloads must not parse files'); } });
  t.after(async () => { await service.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, database, snapshot, session, service, requests, saves: () => saves, registry: toolRegistry(service) };
}

test('downloads original binary files on demand without indexing, sanitizes names and saves private fresh copies', async t => {
  const { database, service, requests, saves, registry } = await fixture(t);
  const first = await callTool(registry, 'download_course_file', { sourceId: 'file:101:7' });
  const bytes = await readFile(first.localPath);
  assert.deepEqual([...bytes], [0, 255, 80, 1]);
  assert.equal(first.fileName, 'experiment.bin');
  assert.equal(first.byteLength, bytes.length);
  assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(first.mimeType, 'application/octet-stream');
  assert.equal(first.url, database.source(first.sourceId).url);
  assert.equal(first.revision, database.source(first.sourceId).revision);
  assert.equal(path.isAbsolute(first.localPath), true);
  assert.equal(database.source(first.sourceId).stale, true);
  assert.equal(database.pages(first.sourceId).length, 0);
  assert.equal(database.jobs().length, 0);
  if (process.platform !== 'win32') {
    assert.equal((await stat(first.localPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(first.localPath))).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(path.dirname(first.localPath)))).mode & 0o777, 0o700);
  }
  const second = await callTool(registry, 'download_course_file', { sourceId: 'file:101:7' });
  assert.notEqual(first.localPath, second.localPath);
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(requests.length, 2);
  assert.equal(saves(), 2);
  service.session.client = async () => { throw new Error('Saved resources must work offline'); };
  assert.deepEqual(Buffer.from((await readDownloadedFile(service, first.id)).blob, 'base64'), bytes);
});

test('MCP returns a discoverable resource link and exact original bytes without putting base64 in tool JSON', async t => {
  const { service } = await fixture(t);
  const server = createServer(service);
  const client = new Client({ name: 'download-fixture', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const tool = tools.tools.find(tool => tool.name === 'download_course_file');
  assert.equal(tool.annotations.openWorldHint, true);
  assert.equal(tool.annotations.idempotentHint, false);
  const result = await client.callTool({ name: 'download_course_file', arguments: { sourceId: 'file:101:7' } });
  assert.equal(result.isError, undefined);
  const link = result.content.find(content => content.type === 'resource_link');
  assert.equal(link.uri, result.structuredContent.resourceUri);
  assert.equal(link.name, 'experiment.bin');
  assert.equal(link.size, 4);
  const resource = await client.readResource({ uri: link.uri });
  assert.deepEqual([...Buffer.from(resource.contents[0].blob, 'base64')], [0, 255, 80, 1]);
  assert.equal(resource.contents[0].mimeType, 'application/octet-stream');
  assert.equal(JSON.stringify(result).includes(resource.contents[0].blob), false);
  const templates = await client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some(template => template.uriTemplate === 'boilerspace://downloads/{id}'));
  const invalid = await client.callTool({ name: 'download_course_file', arguments: { sourceId: '../../session.json' } });
  assert.equal(invalid.isError, true);
  await assert.rejects(client.readResource({ uri: 'boilerspace://downloads/not-a-download' }), /download-not-found/);
});

test('download tools reject unknown IDs, arbitrary paths, external links and inline sources before making requests', async t => {
  const { database, snapshot, registry, requests, service } = await fixture(t);
  for (const sourceId of ['file:101:999', 'assignment:101:1', '../../session.json', 'https://example.com/file']) {
    await assert.rejects(callTool(registry, 'download_course_file', { sourceId }));
  }
  await assert.rejects(callTool(registry, 'download_course_file', { sourceId: 'file:101:7', localPath: '/tmp/override' }), { code: 'invalid-arguments' });
  snapshot.data[0].content[0].fileUrl = 'https://example.com/notes';
  database.publish(snapshot, sourcesFromSnapshot(snapshot));
  await assert.rejects(callTool(registry, 'download_course_file', { sourceId: 'file:101:7' }), { code: 'blocked-request' });
  snapshot.data[0].content[0].fileUrl = null;
  snapshot.data[0].content[0].externalUrl = 'https://example.com/notes';
  snapshot.data[0].overview = { text: 'Inline overview' };
  database.publish(snapshot, sourcesFromSnapshot(snapshot));
  for (const sourceId of ['file:101:7', 'file:101:overview']) {
    await assert.rejects(callTool(registry, 'download_course_file', { sourceId }), { code: 'file-unavailable' });
  }
  await assert.rejects(readDownloadedFile(service, '../../session.json'), { code: 'download-not-found' });
  await assert.rejects(readDownloadedFile(service, '00000000-0000-4000-8000-000000000000'), { code: 'download-not-found' });
  assert.equal(requests.length, 0);
});

test('login pages and expired sessions never become saved downloads', async t => {
  const { directory, session, registry } = await fixture(t);
  session.client = async () => ({ getFile: async () => ({ bytes: Buffer.from('<html><title>Sign in</title><input type="password"></html>'), contentType: 'text/html' }) });
  await assert.rejects(callTool(registry, 'download_course_file', { sourceId: 'file:101:7' }), { code: 'sign-in-required' });
  session.client = async () => { throw Object.assign(new Error('Expired'), { code: 'sign-in-required' }); };
  await assert.rejects(callTool(registry, 'download_course_file', { sourceId: 'file:101:7' }), { code: 'sign-in-required' });
  assert.deepEqual(await readdir(directory), []);
});

test('a source changed during download is rejected and its partially saved file is removed', async t => {
  const { directory, database, snapshot, session, registry } = await fixture(t);
  session.save = async () => {
    snapshot.data[0].content[0].updatedAt = '2026-10-31';
    database.publish(snapshot, sourcesFromSnapshot(snapshot));
  };
  await assert.rejects(callTool(registry, 'download_course_file', { sourceId: 'file:101:7' }), { code: 'source-changed' });
  assert.deepEqual(await readdir(path.join(directory, 'downloads')), []);
});

test('saved resources detect modifications and report removed files', async t => {
  const { service, registry } = await fixture(t);
  const download = await callTool(registry, 'download_course_file', { sourceId: 'file:101:7' });
  await writeFile(download.localPath, Buffer.from([0, 255, 80, 99]));
  await assert.rejects(readDownloadedFile(service, download.id), { code: 'download-changed' });
  await rm(download.localPath);
  await assert.rejects(readDownloadedFile(service, download.id), { code: 'download-not-found' });
});

test('the download tool uses the authenticated restricted transport and its streaming byte limit', async t => {
  const { directory, service, registry } = await fixture(t);
  const jar = new CookieJar();
  await jar.setCookie('session=fixture-secret; Secure; HttpOnly; Path=/', ORIGIN);
  await atomicJson(path.join(directory, 'session.json'), { origin: ORIGIN, cookies: await jar.serialize(), xsrf: 'fixture-xsrf', generation: 'first' });
  let tooLarge = false;
  service.session = new BrightspaceSession(directory, { responseByteLimit: 10, fetchImpl: async (url, options) => {
    assert.equal(url, `${ORIGIN}/d2l/api/le/1.96/101/content/topics/7/file`);
    assert.equal(options.headers.Cookie, 'session=fixture-secret');
    assert.equal(options.redirect, 'manual');
    return new Response(Buffer.alloc(tooLarge ? 11 : 4, 65), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="site-original.bin"' } });
  } });
  const download = await callTool(registry, 'download_course_file', { sourceId: 'file:101:7' });
  assert.equal(download.fileName, 'site-original.bin');
  assert.equal((await readFile(download.localPath)).toString(), 'AAAA');
  assert.equal(JSON.stringify(download).includes('fixture-secret'), false);
  tooLarge = true;
  await assert.rejects(callTool(registry, 'download_course_file', { sourceId: 'file:101:7' }), { code: 'file-too-large' });
  assert.equal((await readdir(path.join(directory, 'downloads'))).length, 1);
});
