import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CourseDatabase } from '../lib/database.mjs';
import { seed } from './fixtures.mjs';

test('a real MCP client uses the CLI subprocess, strict schemas, evidence, resources and research prompt', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boilerspace-protocol-'));
  const database = new CourseDatabase(path.join(directory, 'courses.sqlite'));
  seed(database);
  database.savePages('file:101:7', database.source('file:101:7').revision, [{ label: 'slide 14', text: 'The wavelength is the distance between successive wave peaks.' }]);
  database.close();
  const client = new Client({ name: 'fixture-agent', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'serve', '--data-dir', directory], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 28);
    assert.equal(tools.tools.find(tool => tool.name === 'disconnect_integration').annotations.destructiveHint, true);
    assert.equal(tools.tools.find(tool => tool.name === 'read_quiz').annotations.openWorldHint, true);
    assert.equal(tools.tools.find(tool => tool.name === 'read_document').annotations.readOnlyHint, true);
    const courses = await client.callTool({ name: 'list_courses', arguments: {} });
    assert.equal(courses.structuredContent.courses.length, 2);
    const page = await client.callTool({ name: 'read_document', arguments: { sourceId: 'file:101:7', page: 1 } });
    assert.equal(page.structuredContent.source.location, 'slide 14');
    assert.match(page.structuredContent.text, /wave peaks/);
    const missing = await client.callTool({ name: 'read_document', arguments: { sourceId: 'file:101:999' } });
    assert.equal(missing.isError, true);
    assert.ok(JSON.stringify(missing).includes('source-not-found'));
    const invalid = await client.callTool({ name: 'read_document', arguments: { sourceId: '../../session.json' } });
    assert.equal(invalid.isError, true);
    const resource = await client.readResource({ uri: 'boilerspace://status' });
    assert.equal(JSON.parse(resource.contents[0].text).indexedDocuments, 1);
    const prompt = await client.getPrompt({ name: 'exam-review' });
    assert.match(prompt.messages[0].content.text, /course_coverage/);
    assert.ok(!JSON.stringify([courses, page, resource]).includes('session.json'));
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
  assert.ok(!/Unhandled|Error:/.test(stderr), stderr);
});
