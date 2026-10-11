// The relay: runs the user's coding tools one after another. Each tool runs
// as itself, on the user's own account, in this terminal. When one runs out
// of usage, SeamlessAI closes it and opens the next, carrying the work over:
// the same conversation when the next step is the same tool on free models,
// or a handoff note when it is a different tool.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { SessionWatcher, codexDir } from './sessions.js';
import { writeHandoff } from './handoff.js';

export const STEPS = {
  claude: { tool: 'claude', free: false, label: 'Claude Code (your account)' },
  codex: { tool: 'codex', free: false, label: 'Codex (your account)' },
  'claude-free': { tool: 'claude', free: true, label: 'Claude Code on free models' },
  'codex-free': { tool: 'codex', free: true, label: 'Codex on free models' },
};

/**
 * How Claude Code asks permission on free models (`seamless relay --free-mode`).
 * In auto mode every tool call is first checked by a model, which on the free
 * step would be a free model (possibly one that logs prompts), so the
 * default lets file edits through and asks before commands.
 */
export const FREE_MODES = { edits: 'acceptEdits', ask: 'manual', auto: 'auto' };
export const DEFAULT_FREE_MODE = 'edits';
// Commands that only look and never change anything run without asking in edits and ask modes.
const READ_ONLY = ['Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(ls*)', 'Bash(dir*)', 'Bash(pwd)'];

export const PROFILE = 'seamless';
const PROFILE_MARK = '# Written by SeamlessAI';
const POLL_MS = 1500;
/** Codex doesn't say when its limit resets; it is tried again after this long. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;
// Sent when the same conversation is reopened after running out, so the
// request that hit the limit gets its answer without the user typing it again.
const CONTINUE_PROMPT = 'Continue where you left off.';
const HANDOFF_PROMPT = 'SeamlessAI handoff. You are taking over this project from another AI coding tool that ran out of usage. Read .seamless/handoff.md first, then continue with the next steps it lists.';

/** The full path of a command on PATH, or null. */
export function findCommand(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

/** The default order: each installed tool on the user's account, then free models. */
export function defaultOrder(installed = (tool) => Boolean(findCommand(tool))) {
  const order = ['claude', 'codex'].filter(installed);
  if (installed('claude')) order.push('claude-free');
  else if (installed('codex')) order.push('codex-free');
  return order;
}

export function relayOrder(config = loadConfig()) {
  return config.relay?.order?.length ? config.relay.order : defaultOrder();
}

export function freeMode(config = loadConfig()) {
  return FREE_MODES[config.relay?.freeMode] ? config.relay.freeMode : DEFAULT_FREE_MODE;
}

/** Checks a comma-separated order typed by the user. Returns the list, or throws with the reason. */
export function parseOrder(text) {
  const order = String(text).split(/[\s,>]+/).filter(Boolean);
  const unknown = order.filter((id) => !STEPS[id]);
  if (unknown.length) throw new Error(`Unknown step(s): ${unknown.join(', ')}. Steps: ${Object.keys(STEPS).join(', ')}`);
  if (order.length === 0) throw new Error('The order needs at least one step.');
  return order;
}

/**
 * Codex reads extra settings from <CODEX_HOME>/<profile>.config.toml when
 * started with --profile. SeamlessAI's profile points Codex at the local
 * server; the user's own config.toml is never touched.
 */
export function ensureCodexProfile(port) {
  const file = path.join(codexDir(), `${PROFILE}.config.toml`);
  let existing = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {}
  if (existing !== null && !existing.startsWith(PROFILE_MARK)) return { file, written: false };
  const text = `${PROFILE_MARK}. \`codex --profile ${PROFILE}\` runs Codex on SeamlessAI's free models.
model_provider = "seamless"
model = "auto"
model_context_window = 128000

[model_providers.seamless]
name = "SeamlessAI (free models)"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
`;
  if (existing !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { file, written: true };
}

/** The command line and environment for one step. `carry` is { resume } or { prompt }. */
export function commandFor(id, { carry = {}, port, mode = DEFAULT_FREE_MODE }) {
  const step = STEPS[id];
  const args = [];
  const env = { ...process.env };
  if (step.tool === 'claude') {
    if (carry.resume) args.push('--resume', carry.resume);
    if (step.free) {
      const permissionMode = FREE_MODES[mode] ?? FREE_MODES[DEFAULT_FREE_MODE];
      // The tool list takes every argument up to the next option, so an option must follow it.
      if (permissionMode !== 'auto') args.push('--allowedTools', READ_ONLY.join(','));
      args.push('--permission-mode', permissionMode);
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
      env.ANTHROPIC_AUTH_TOKEN = 'seamless';
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      delete env.ANTHROPIC_API_KEY; // a real key here would make Claude Code ask which to use
    } else if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}(/|$)`).test(env.ANTHROPIC_BASE_URL || '')) {
      // Left over from pointing Claude Code at SeamlessAI by hand: the
      // account step has to reach Anthropic.
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
  } else {
    if (carry.resume) args.push('resume');
    if (step.free) args.push('--profile', PROFILE);
    if (carry.resume) args.push(carry.resume);
  }
  if (carry.prompt) args.push(carry.prompt);
  return { command: step.tool, args, env };
}

/**
 * Runs the relay in `cwd`. Resolves when the user is done or nothing is
 * left to switch to. `ask(question)` resolves with the user's answer;
 * `ensureServer()` starts SeamlessAI in the background; `summarize(prompt)`
 * asks a free model (for the handoff note).
 */
export async function relay({ order, from, cwd = process.cwd(), port, ask, log = console.log, ensureServer, summarize, now = Date.now }) {
  const config = loadConfig();
  const outUntil = { ...(config.relayOut || {}) };
  const mode = freeMode(config);
  const steps = [...order];
  let i = from ? steps.indexOf(from) : 0;
  if (i < 0) throw new Error(`"${from}" is not in the relay order (${steps.join(', ')}).`);

  const skipReason = (id) => {
    const step = STEPS[id];
    if (!findCommand(step.tool)) return `${step.tool} isn't installed`;
    if (!step.free && outUntil[id] > now()) return `it's out of usage until ${new Date(outUntil[id]).toLocaleTimeString()}`;
    return null;
  };
  const nextUsable = (after) => {
    for (let j = after + 1; j < steps.length; j++) if (!skipReason(steps[j])) return j;
    return -1;
  };

  let carry = {};
  for (;;) {
    const id = steps[i];
    const step = STEPS[id];
    const reason = skipReason(id);
    if (reason) {
      log(`Skipping ${step.label}: ${reason}.`);
      i = nextUsable(i);
      if (i < 0) return log('Nothing left to switch to. Run `seamless relay` to see or change the order.');
      continue;
    }
    if (step.free) {
      await ensureServer();
      if (step.tool === 'codex') ensureCodexProfile(port);
    }

    log(`\n▶ ${step.label}${carry.resume ? ', continuing the same conversation' : carry.prompt ? ', picking up from the handoff note' : ''}\n`);
    const result = await runStep(id, { carry, port, cwd, mode });

    if (result.outOfUsage) {
      const until = result.outOfUsage.resetsAt ?? now() + UNKNOWN_RESET_MS;
      outUntil[id] = until;
      const fresh = loadConfig();
      fresh.relayOut = { ...(fresh.relayOut || {}), [id]: until };
      saveConfig(fresh);
      log(`\n${step.label} ran out of usage${result.outOfUsage.resetsAt ? ` (it resets at ${new Date(until).toLocaleTimeString()})` : ''}.`);
    }

    const next = nextUsable(i);
    if (next < 0) {
      if (result.outOfUsage) log('Nothing left to switch to. Run `seamless relay` to see or change the order.');
      return;
    }
    if (!result.outOfUsage) {
      const answer = await ask(`\n${step.label} closed. Switch to ${STEPS[steps[next]].label}? (y/N) `);
      if (!/^y/i.test(answer.trim())) return;
    }

    const nextStep = STEPS[steps[next]];
    // After running out, the last request still needs an answer; after the
    // user closed the tool themselves, they say what's next.
    if (nextStep.tool === step.tool && result.sessionId) carry = result.outOfUsage ? { resume: result.sessionId, prompt: CONTINUE_PROMPT } : { resume: result.sessionId };
    else {
      log(`Writing a handoff note for ${nextStep.label}...`);
      let summarizer = summarize;
      try {
        await ensureServer();
      } catch (err) {
        log(`SeamlessAI couldn't start (${err.message.split('\n')[0]}), so the note will carry the session log instead of a summary.`);
        summarizer = null;
      }
      const file = await writeHandoff({ cwd, from: step.label, to: nextStep.label, tool: step.tool, file: result.file, summarize: summarizer, log });
      log(`Saved ${path.relative(cwd, file)}.`);
      carry = { prompt: HANDOFF_PROMPT };
    }
    i = next;
  }
}

/**
 * Runs one step in this terminal and resolves when it closes:
 * { outOfUsage, sessionId, file }. A tool on the user's account is closed
 * as soon as its session file shows it ran out of usage.
 */
export async function runStep(id, { carry = {}, port, cwd = process.cwd(), mode }) {
  const step = STEPS[id];
  const { command, args, env } = commandFor(id, { carry, port, mode });
  const watcher = new SessionWatcher(step.tool, { cwd, since: Date.now() });
  const child = spawnTool(findCommand(command) || command, args, { cwd, env });

  // Ctrl+C is meant for the tool. It reaches this process too, which must
  // stay alive to switch tools.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  let stopping = false;
  const timer = setInterval(() => {
    if (step.free || stopping) return;
    if (watcher.poll().outOfUsage) {
      stopping = true;
      // Give the tool a moment to finish drawing its message.
      setTimeout(() => stopProcess(child), 1500);
    }
  }, POLL_MS);
  try {
    await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
  } finally {
    clearInterval(timer);
    process.off('SIGINT', ignore);
  }
  if (stopping) resetTerminal();
  const seen = watcher.poll();
  return { outOfUsage: step.free ? null : seen.outOfUsage, sessionId: seen.sessionId ?? carry.resume ?? null, file: seen.file };
}

function spawnTool(file, args, { cwd, env }) {
  // npm installs tools on Windows as .cmd scripts, which only run through
  // the shell, so the arguments are quoted for it.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const quote = (a) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    return spawn([file, ...args].map(quote).join(' '), { cwd, env, stdio: 'inherit', shell: true });
  }
  return spawn(file, args, { cwd, env, stdio: 'inherit' });
}

function stopProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
}

/** Undoes what a full-screen tool that was closed mid-way may have left on: alternate screen, hidden cursor, mouse and paste modes. */
function resetTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[0m\r\n');
  if (process.platform !== 'win32' && process.stdin.isTTY) spawnSync('stty', ['sane'], { stdio: 'inherit' });
}
