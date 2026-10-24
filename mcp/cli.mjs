#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, privateDirectory } from './lib/config.mjs';
import { CourseDatabase } from './lib/database.mjs';
import { BrightspaceSession } from './lib/session.mjs';
import { CourseService } from './lib/service.mjs';
import { toolRegistry, callTool } from './lib/tools.mjs';
import { CompanionError, publicError } from './lib/errors.mjs';
import { serve } from './server.mjs';
import { ProviderSession, SITES } from './lib/providers.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'data-dir': { type: 'string' }, args: { type: 'string', default: '{}' }, browser: { type: 'string' }, site: { type: 'string', default: 'brightspace' }, wait: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  const command = positionals[0] ?? 'help';
  if (command === 'help' || values.help) {
    console.log('BoilerSpace companion\n\nlogin                 Sign into a site in a separate browser.\nlogout                Remove companion credentials and its browser profile; keep indexed material.\nserve                 Run the MCP server over stdio.\nstatus                Inspect the index and jobs.\ntools                 Print available tools and their JSON schemas.\ncall TOOL --args JSON  Call the same tool exposed through MCP.\n                      Add --wait to wait for an indexing/sync job.\n\nOptions: --data-dir PATH, --browser EXECUTABLE (login only), --site brightspace|ed|piazza|gradescope|all (login/logout).\nNo extension or GenAI Studio key is required.');
    return;
  }
  process.umask(0o077);
  const directory = await privateDirectory(dataDirectory(values['data-dir']));
  if (values.site !== 'brightspace' && values.site !== 'all' && !SITES[values.site]) throw new CompanionError('unknown-site', 'Choose brightspace, ed, piazza or gradescope.');
  if (!['login', 'logout'].includes(command) && values.site !== 'brightspace') throw new CompanionError('invalid-arguments', 'Use --site with login or logout. Research tools select their platform through tool arguments.');
  if (values.site === 'all') {
    const results = [];
    for (const session of [new BrightspaceSession(directory), ...Object.keys(SITES).map(site => new ProviderSession(directory, site))]) {
      results.push(command === 'login' ? await session.login({ executablePath: values.browser, onStatus: text => console.error(text) }) : await session.logout());
    }
    console.log(JSON.stringify({ sites: results })); return;
  }
  const session = values.site === 'brightspace' ? new BrightspaceSession(directory) : new ProviderSession(directory, values.site);
  if (command === 'login') { console.log(JSON.stringify(await session.login({ executablePath: values.browser, onStatus: text => console.error(text) }))); return; }
  if (command === 'logout') { console.log(JSON.stringify(await session.logout())); return; }
  const database = new CourseDatabase(path.join(directory, 'courses.sqlite'));
  const service = new CourseService(database, session);
  let running = false;
  const close = async () => { await service.close(); database.close(); };
  try {
    if (command === 'serve') {
      const server = await serve(service);
      running = true;
      let closing = false;
      const stop = async () => { if (closing) return; closing = true; await close(); await server.close(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop); process.stdin.once('end', stop);
      return;
    }
    const registry = toolRegistry(service);
    if (command === 'tools') {
      const { z } = await import('zod');
      console.log(JSON.stringify(Object.entries(registry).map(([name, tool]) => ({ name, description: tool.description, inputSchema: z.toJSONSchema(tool.schema) })), null, 2));
      return;
    }
    let result;
    if (command === 'status') result = service.status();
    else if (command === 'call') {
      let args;
      try { args = JSON.parse(values.args); }
      catch { throw new CompanionError('invalid-arguments', '--args must contain valid JSON.'); }
      result = await callTool(registry, positionals[1], args);
    } else throw new CompanionError('unknown-command', 'Unknown command. Run help to see companion commands.');
    if (values.wait && result.id && ['queued', 'running'].includes(result.state)) {
      service.start();
      do { await new Promise(resolve => setTimeout(resolve, 100)); result = database.job(result.id); }
      while (['queued', 'running'].includes(result.state));
      if (result.state !== 'completed' || result.failures.length) process.exitCode = 1;
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { if (!running) await close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; });
