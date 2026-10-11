import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionWatcher, digest } from '../src/sessions.js';
import { relay, defaultOrder, parseOrder, commandFor, ensureCodexProfile } from '../src/relay.js';
import { writeHandoff } from '../src/handoff.js';
import { loadConfig, saveConfig } from '../src/config.js';

// Each test file runs in its own process, so these only affect this file.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seamless-relay-'));
const bin = path.join(root, 'bin');
const project = path.join(root, 'project');
const record = path.join(root, 'runs.jsonl');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.SEAMLESS_HOME = path.join(root, 'seamless');
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
delete process.env.ANTHROPIC_BASE_URL;

const NOW = '2099-01-01T00:00:00.000Z'; // entries "written" after any test starts

function claudeFile(sessionId, cwd = project) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

function codexFile(sessionId) {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2099', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2099-01-01T00-00-00-${sessionId}.jsonl`);
}

const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

const claudeEntries = (sessionId, cwd = project) => [
  { type: 'queue-operation' },
  { type: 'user', cwd, sessionId, timestamp: NOW, message: { role: 'user', content: 'build a todo app' } },
  { type: 'assistant', cwd, sessionId, timestamp: NOW, message: { role: 'assistant', content: [{ type: 'text', text: 'Creating the files.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'app.js', content: 'x'.repeat(5000) } }] } },
  { type: 'user', cwd, sessionId, timestamp: NOW, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET TOOL OUTPUT' }] } },
];

const claudeLimit = (sessionId, cwd = project) => ({
  type: 'system',
  subtype: 'api_error',
  cwd,
  sessionId,
  timestamp: NOW,
  error: { status: 429, rateLimits: { rateLimitType: 'five_hour', resetsAt: 4070912400 } },
});

const codexEntries = (sessionId, cwd = project) => [
  { timestamp: NOW, type: 'session_meta', payload: { id: sessionId, cwd } },
  { timestamp: NOW, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>noise</environment_context>' }] } },
  { timestamp: NOW, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a login page' }] } },
  { timestamp: NOW, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls src"}', call_id: 'c1' } },
  { timestamp: NOW, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'SECRET TOOL OUTPUT' } },
];

const codexLimit = { timestamp: NOW, type: 'event_msg', payload: { type: 'task_complete', error: { message: 'You hit your usage limit.', codex_error_info: 'usage_limit_exceeded' } } };

/**
 * A fake `claude` or `codex` on PATH. It records how it was started, then
 * writes `lines` into its session file (as the real tool would) and either
 * exits or, on the user's account, waits to be closed.
 */
function fakeTool(name, { file, lines, wait }) {
  const script = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ tool: ${JSON.stringify(name)}, args: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL || null, cwd: process.cwd() }) + '\\n');
${file ? `fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(lines)});` : ''}
${wait ? "if (!process.env.ANTHROPIC_BASE_URL) setInterval(() => {}, 1000);" : ''}
`;
  if (process.platform === 'win32') {
    // Windows runs neither shebangs nor extensionless files: a .cmd wrapper
    // stands in, like the ones npm installs.
    fs.writeFileSync(path.join(bin, `${name}.js`), script);
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@node "%~dp0${name}.js" %*\r\n`);
  } else fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
}

function runs() {
  try {
    return fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function reset() {
  for (const d of [bin, project, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.SEAMLESS_HOME]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.rmSync(record, { force: true });
}

before(reset);

test('the default order is each installed tool, then free models', () => {
  assert.deepEqual(defaultOrder(() => true), ['claude', 'codex', 'claude-free']);
  assert.deepEqual(defaultOrder((t) => t === 'codex'), ['codex', 'codex-free']);
  assert.deepEqual(defaultOrder(() => false), []);
  assert.deepEqual(parseOrder('codex, claude > claude-free'), ['codex', 'claude', 'claude-free']);
  assert.throws(() => parseOrder('claude, gemini'), /Unknown step\(s\): gemini/);
});

test('each step starts its tool the right way', () => {
  assert.deepEqual(commandFor('claude', { port: 4141 }).args, []);
  // A base URL left over from pointing Claude Code at SeamlessAI by hand
  // would send the account step to free models.
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:4141';
  assert.equal(commandFor('claude', { port: 4141 }).env.ANTHROPIC_BASE_URL, undefined);
  delete process.env.ANTHROPIC_BASE_URL;
  const free = commandFor('claude-free', { port: 4141, carry: { resume: 'abc' } });
  assert.deepEqual(free.args, ['--resume', 'abc']);
  assert.equal(free.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4141');
  assert.deepEqual(commandFor('codex-free', { port: 4141, carry: { resume: 'xyz' } }).args, ['resume', '--profile', 'seamless', 'xyz']);
  assert.deepEqual(commandFor('codex', { port: 4141, carry: { prompt: 'go on' } }).args, ['go on']);
});

test('the Codex profile is its own file, and a file SeamlessAI did not write is left alone', () => {
  reset();
  const { file, written } = ensureCodexProfile(4141);
  assert.ok(written);
  assert.match(fs.readFileSync(file, 'utf8'), /base_url = "http:\/\/127\.0\.0\.1:4141\/v1"/);
  ensureCodexProfile(5000);
  assert.match(fs.readFileSync(file, 'utf8'), /127\.0\.0\.1:5000/);
  fs.writeFileSync(file, 'model = "mine"\n');
  assert.equal(ensureCodexProfile(4141).written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "mine"\n');
});

test('the watcher spots a used-up plan in this folder only', () => {
  reset();
  const since = Date.now();
  const other = path.join(root, 'other');
  fs.writeFileSync(claudeFile('s-other', other), jsonl(...claudeEntries('s-other', other), claudeLimit('s-other', other)));
  const file = claudeFile('s1');
  fs.writeFileSync(file, jsonl(...claudeEntries('s1')));
  const watcher = new SessionWatcher('claude', { cwd: project, since });
  assert.deepEqual(watcher.poll(), { sessionId: 's1', file, outOfUsage: null });
  // Neither an overloaded server nor a brief rate limit (no plan limits attached) is "out of usage".
  fs.appendFileSync(file, jsonl({ type: 'system', subtype: 'api_error', cwd: project, sessionId: 's1', timestamp: NOW, error: { status: 529 } }));
  assert.equal(watcher.poll().outOfUsage, null);
  fs.appendFileSync(file, jsonl({ type: 'system', subtype: 'api_error', cwd: project, sessionId: 's1', timestamp: NOW, error: { status: 429 } }));
  assert.equal(watcher.poll().outOfUsage, null);
  fs.appendFileSync(file, jsonl(claudeLimit('s1')));
  assert.deepEqual(watcher.poll().outOfUsage, { resetsAt: 4070912400000, kind: 'five_hour' });

  // The interactive app saves the message it shows, with a code.
  const shown = claudeFile('s3');
  fs.writeFileSync(shown, jsonl(...claudeEntries('s3'), { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', cwd: project, sessionId: 's3', timestamp: NOW, message: { content: [{ type: 'text', text: "You've hit your session limit · resets 11:15pm" }] } }));
  assert.equal(new SessionWatcher('claude', { cwd: project, since }).poll().outOfUsage?.kind, 'rate_limit');

  const cfile = codexFile('c1');
  fs.writeFileSync(cfile, jsonl(...codexEntries('c1'), codexLimit));
  const codex = new SessionWatcher('codex', { cwd: project, since });
  assert.deepEqual(codex.poll(), { sessionId: 'c1', file: cfile, outOfUsage: { resetsAt: null, kind: 'usage_limit' } });
});

test('the digest keeps requests, replies and tool calls, not tool output', () => {
  reset();
  const file = claudeFile('s1');
  fs.writeFileSync(file, jsonl(...claudeEntries('s1')));
  assert.equal(digest('claude', file), 'USER: build a todo app\nASSISTANT: Creating the files.\nTOOL Write: app.js');
  const cfile = codexFile('c1');
  fs.writeFileSync(cfile, jsonl(...codexEntries('c1')));
  assert.equal(digest('codex', cfile), 'USER: add a login page\nTOOL exec_command: ls src');
});

test('the handoff note falls back to the session log when no summary can be written', async () => {
  reset();
  const file = codexFile('c1');
  fs.writeFileSync(file, jsonl(...codexEntries('c1')));
  const note = await writeHandoff({ cwd: project, from: 'Codex', to: 'Claude Code', tool: 'codex', file, summarize: async () => { throw new Error('down'); } });
  const text = fs.readFileSync(note, 'utf8');
  assert.match(text, /Codex ran out of usage/);
  assert.match(text, /USER: add a login page/);
  assert.equal(fs.readFileSync(path.join(project, '.seamless', '.gitignore'), 'utf8'), '*\n');
});

const quiet = () => {};

test('Claude Code running out switches to Claude Code on free models, same conversation', async () => {
  reset();
  // The account step hits its limit and stays open, like the real app.
  fakeTool('claude', { file: claudeFile('sess-1'), lines: jsonl(...claudeEntries('sess-1'), claudeLimit('sess-1')), wait: true });
  let servers = 0;
  const asked = [];
  await relay({
    order: ['claude', 'claude-free'],
    cwd: project,
    port: 4141,
    log: quiet,
    ask: async (q) => (asked.push(q), ''),
    ensureServer: async () => servers++,
  });
  const [first, second] = runs();
  assert.deepEqual(first.args, []);
  assert.equal(first.base, null);
  assert.deepEqual(second.args, ['--resume', 'sess-1', 'Continue where you left off.']);
  assert.equal(second.base, 'http://127.0.0.1:4141');
  assert.ok(servers >= 1);
  assert.equal(asked.length, 0); // the last step closing ends the relay without a question
  // The account is remembered as out until its reset time, so the next run skips it.
  assert.equal(loadConfig().relayOut.claude, 4070912400000);
});

test('Codex running out hands over to Claude Code with a note', async () => {
  reset();
  fakeTool('codex', { file: codexFile('cx-1'), lines: jsonl(...codexEntries('cx-1'), codexLimit) });
  fakeTool('claude', {});
  const prompts = [];
  await relay({
    order: ['codex', 'claude'],
    cwd: project,
    port: 4141,
    log: quiet,
    ask: async () => '',
    ensureServer: async () => {},
    summarize: async (prompt) => (prompts.push(prompt), '## Goal\nA login page.'),
  });
  const [codex, claude] = runs();
  assert.equal(codex.tool, 'codex');
  assert.equal(claude.tool, 'claude');
  assert.match(claude.args.at(-1), /Read \.seamless\/handoff\.md first/);
  assert.match(prompts[0], /USER: add a login page/);
  assert.doesNotMatch(prompts[0], /SECRET TOOL OUTPUT/);
  assert.match(fs.readFileSync(path.join(project, '.seamless', 'handoff.md'), 'utf8'), /## Goal\nA login page\./);
});

test('closing a tool normally asks before switching, and skips tools still out of usage', async () => {
  reset();
  fakeTool('claude', { file: claudeFile('s2'), lines: jsonl(...claudeEntries('s2')) });
  fakeTool('codex', {});
  const asked = [];
  await relay({ order: ['claude', 'codex'], cwd: project, port: 4141, log: quiet, ask: async (q) => (asked.push(q), 'n'), ensureServer: async () => {} });
  assert.equal(runs().length, 1);
  assert.match(asked[0], /Switch to Codex \(your account\)\?/);

  // Claude is marked out: the next run starts with Codex.
  fs.rmSync(record);
  const lines = [];
  await relay({ order: ['claude', 'codex'], cwd: project, port: 4141, log: (l) => lines.push(l), ask: async () => '', ensureServer: async () => {}, now: () => Date.now() });
  assert.equal(runs()[0].tool, 'claude'); // nothing marked it out yet
  saveConfig({ ...loadConfig(), relayOut: { claude: Date.now() + 60_000 } });
  fs.rmSync(record);
  await relay({ order: ['claude', 'codex'], cwd: project, port: 4141, log: (l) => lines.push(l), ask: async () => '', ensureServer: async () => {} });
  assert.deepEqual(runs().map((r) => r.tool), ['codex']);
  assert.ok(lines.some((l) => /Skipping Claude Code \(your account\): it's out of usage until/.test(l)));
});
