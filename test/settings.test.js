import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Router } from '../src/router.js';
import { createServer } from '../src/server.js';
import { liveConfig, loadConfig, saveConfig } from '../src/config.js';
import { fakeModel, catalogOf, chat } from './helpers.js';

// Each test file runs in its own process, so this only affects this file.
process.env.SEAMLESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'seamless-settings-'));
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'seamless.js');

const open = [];
after(() => open.forEach((c) => c.close()));

/** Runs the CLI with the same SEAMLESS_HOME; resolves with { code, out }. */
function cli(...args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

test('a running router sees settings saved after it started, such as private mode', async () => {
  const logs = await fakeModel(() => ({ content: 'from the logging provider' }));
  const quiet = await fakeModel(() => ({ content: 'from the private provider' }));
  open.push(logs, quiet);
  saveConfig({ keys: {} });
  const router = new Router({ catalog: catalogOf(['logs', logs, { mayLogPrompts: true }], ['quiet', quiet]), getConfig: liveConfig() });

  assert.equal((await router.dispatch(chat())).target.provider.id, 'logs');
  await new Promise((r) => setTimeout(r, 20)); // a new modification time
  assert.equal(cli('private', 'on').code, 0);
  assert.equal((await router.dispatch(chat())).target.provider.id, 'quiet');
});

test('a config file that is broken mid-write keeps the last good settings', async () => {
  saveConfig({ keys: {}, trim: 'off' });
  const get = liveConfig();
  fs.writeFileSync(path.join(process.env.SEAMLESS_HOME, 'config.json'), '{ "keys": ');
  assert.equal(get().trim, 'off');
});

test('malformed Anthropic and Responses bodies get a 400, not a server error', async () => {
  const upstream = await fakeModel(() => ({ content: 'hi' }));
  open.push(upstream);
  const server = createServer(new Router({ catalog: catalogOf(['a', upstream]), config: { keys: {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  open.push({ close: () => (server.closeAllConnections(), server.close()) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const messages = await post('/v1/messages', { model: 'claude-x', max_tokens: 10, messages: [{ role: 'user', content: null }] });
  assert.equal(messages.status, 400);
  assert.match((await messages.json()).error.message, /Malformed request/);
  const count = await post('/v1/messages/count_tokens', { messages: [{ role: 'user', content: null }] });
  assert.equal(count.status, 400);
  const responses = await post('/v1/responses', { input: [null] });
  assert.equal(responses.status, 400);
});

test('the CLI saves keys, trim and private settings, and explains bad input', () => {
  saveConfig({ keys: {} });
  assert.match(cli('keys', 'set', 'groq', 'gsk_example').out, /Saved key for Groq/);
  assert.equal(loadConfig().keys.groq, 'gsk_example');
  assert.match(cli('keys', 'remove', 'groq').out, /Removed key/);
  assert.equal(loadConfig().keys.groq, undefined);

  assert.equal(cli('trim', 'auto', '120').code, 0);
  assert.deepEqual([loadConfig().trim, loadConfig().trimWaitSeconds], ['auto', 120]);
  assert.equal(cli('trim', 'sometimes').code, 1);

  const noKey = cli('keys', 'set', 'groq');
  assert.equal(noKey.code, 1);
  assert.match(noKey.out, /Usage: seamless keys set <provider> \[<key>\]/);
  assert.match(cli('code', '--from').out, /--from needs a step/);
  assert.match(cli('nonsense').out, /Unknown command "nonsense"/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(process.env.SEAMLESS_HOME, 'config.json')).mode & 0o777, 0o600);
});
