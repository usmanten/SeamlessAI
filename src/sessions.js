// Reads the conversations Claude Code and Codex save on this computer: to
// notice when one has run out of usage, to find the session to resume, and
// to boil a session down for the handoff note. Nothing here talks to
// Anthropic or OpenAI; it only reads the tools' own local files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function codexDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Whether two folder paths are the same folder (Windows paths ignore case). */
export function sameFolder(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** .jsonl files under `dir` (to `depth` levels) changed at or after `since`. */
function recentJsonl(dir, since, depth) {
  const out = [];
  const walk = (d, level) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && level < depth) walk(full, level + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(full).mtimeMs >= since) out.push(full);
        } catch {}
      }
    }
  };
  walk(dir, 1);
  return out;
}

/**
 * Codex keeps sessions in sessions/YYYY/MM/DD/. Only the newest two day
 * folders are looked at, which covers a session that crosses midnight.
 */
function codexSessionFiles(since) {
  const root = path.join(codexDir(), 'sessions');
  const newest = (dir) => {
    try {
      return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  const days = [];
  for (const y of newest(root)) {
    for (const m of newest(path.join(root, y))) {
      for (const d of newest(path.join(root, y, m))) {
        days.push(path.join(root, y, m, d));
        if (days.length === 2) break;
      }
      if (days.length === 2) break;
    }
    if (days.length === 2) break;
  }
  return days.flatMap((d) => recentJsonl(d, since, 1));
}

/**
 * Watches one tool's session files for the current folder, reading only
 * what was added since the last look. `poll()` returns
 * { sessionId, file, outOfUsage: null | { resetsAt } }.
 */
export class SessionWatcher {
  constructor(tool, { cwd = process.cwd(), since = Date.now() } = {}) {
    this.tool = tool; // 'claude' or 'codex'
    this.cwd = cwd;
    this.since = since - 2000; // file times can lag the clock slightly
    this.files = new Map(); // file -> { offset, rest, mine, sessionId }
    this.sessionId = null;
    this.file = null;
    this.outOfUsage = null;
  }

  poll() {
    const files = this.tool === 'claude' ? recentJsonl(path.join(claudeDir(), 'projects'), this.since, 2) : codexSessionFiles(this.since);
    for (const file of files) this.read(file);
    return { sessionId: this.sessionId, file: this.file, outOfUsage: this.outOfUsage };
  }

  read(file) {
    let state = this.files.get(file);
    if (!state) this.files.set(file, (state = { offset: 0, rest: '', mine: null, sessionId: null }));
    if (state.mine === false) return;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= state.offset) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - state.offset);
    try {
      fs.readSync(fd, buf, 0, buf.length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
    state.offset = size;
    const lines = (state.rest + buf.toString('utf8')).split('\n');
    state.rest = lines.pop();
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      this.take(entry, state, file);
      if (state.mine === false) return;
    }
  }

  take(entry, state, file) {
    // Which folder the session belongs to: Claude Code puts it on every
    // entry, Codex in the first ("session_meta") line.
    const cwd = this.tool === 'claude' ? entry.cwd : entry.type === 'session_meta' ? entry.payload?.cwd : undefined;
    if (cwd !== undefined && state.mine === null) {
      state.mine = sameFolder(cwd, this.cwd);
      if (!state.mine) return;
    }
    if (state.mine === null) return;
    const sessionId = this.tool === 'claude' ? entry.sessionId : entry.type === 'session_meta' ? entry.payload?.id : null;
    if (sessionId) state.sessionId = sessionId;
    if (state.sessionId) {
      this.sessionId = state.sessionId;
      this.file = file;
    }
    const time = Date.parse(entry.timestamp);
    if (Number.isFinite(time) && time < this.since) return; // an old session being resumed
    const out = this.tool === 'claude' ? claudeOutOfUsage(entry) : codexOutOfUsage(entry);
    if (out) this.outOfUsage = out;
  }
}

/**
 * Claude Code records a failed request as a "system" entry with the HTTP
 * error. A 429 that carries plan limits (rateLimits, from Anthropic's usage
 * headers) means the account's allowance is used up, as opposed to a brief
 * rate limit. In the interactive app the message shown to the user is
 * saved too, marked as an API error with the code "rate_limit", and with
 * the plan's limits ("rejected", and when it resets) when Anthropic sent them.
 * A request that runs out partway through can instead come back as a 429
 * with a usage or credit code (seen: "extra_usage_out_of_credits") and the
 * generic error "unknown".
 */
export function claudeOutOfUsage(entry) {
  const err = entry.error;
  if (entry.type === 'system' && err?.status === 429 && err.rateLimits?.rateLimitType) {
    return { resetsAt: err.rateLimits.resetsAt ? err.rateLimits.resetsAt * 1000 : null, kind: err.rateLimits.rateLimitType };
  }
  if (entry.type === 'assistant' && entry.isApiErrorMessage) {
    const quota = entry.quotaLimits ?? entry.apiErrorParams?.rate_limit_info;
    if (quota?.status === 'rejected') return { resetsAt: quota.resetsAt ? quota.resetsAt * 1000 : null, kind: quota.rateLimitType || 'rate_limit' };
    const code = entry.apiErrorCode || entry.apiError || '';
    if (entry.apiErrorStatus === 429 && /usage|credit|quota/i.test(code)) return { resetsAt: null, kind: code };
    const text = (entry.message?.content || []).map((b) => b.text ?? '').join(' ');
    if (entry.error === 'rate_limit' || /usage limit|hit your (\w+ )?limit|limit reached/i.test(text)) return { resetsAt: null, kind: 'rate_limit' };
  }
  return null;
}

/** Codex marks a turn that ended on a used-up plan with the code usage_limit_exceeded. */
export function codexOutOfUsage(entry) {
  const p = entry.payload;
  if (entry.type !== 'event_msg' || !p) return null;
  const code = p.error?.codex_error_info ?? p.codex_error_info;
  return code === 'usage_limit_exceeded' ? { resetsAt: null, kind: 'usage_limit' } : null;
}

const MAX_TEXT = 1500; // characters kept from any one message
const MAX_DIGEST = 40_000; // characters in the whole digest

/**
 * A session as a short plain-text log: what the user asked, what the
 * assistant said, and one line per tool call. Tool output and file contents
 * are left out; they are most of a session's size and the next tool can
 * look at the files itself.
 */
export function digest(tool, file) {
  const lines = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const l of tool === 'claude' ? claudeLines(entry) : codexLines(entry)) lines.push(l);
  }
  // Keep the first request (it usually says what the project is) and as
  // much of the end as fits.
  const first = lines.findIndex((l) => l.startsWith('USER:'));
  const head = first >= 0 ? [lines[first]] : [];
  const tail = [];
  let size = head.join('\n').length;
  for (let i = lines.length - 1; i > first; i--) {
    if (size + lines[i].length + 1 > MAX_DIGEST) {
      tail.unshift('[... earlier messages left out ...]');
      break;
    }
    tail.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  return [...head, ...tail].join('\n');
}

function clip(text) {
  const t = String(text).trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)} [...]` : t;
}

/** One line describing a tool call, with the argument that says what it touched. */
function toolLine(name, input) {
  let args = input;
  if (typeof input === 'string') {
    try {
      args = JSON.parse(input);
    } catch {
      return `TOOL ${name}: ${clip(input).slice(0, 200)}`;
    }
  }
  const key = ['file_path', 'path', 'command', 'cmd', 'pattern', 'url', 'description'].find((k) => typeof args?.[k] === 'string');
  const detail = key ? args[key] : Array.isArray(args?.command) ? args.command.join(' ') : '';
  return `TOOL ${name}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}

function claudeLines(entry) {
  if (entry.isSidechain || entry.isMeta || !entry.message) return [];
  const content = entry.message.content;
  if (entry.type === 'user') {
    if (typeof content === 'string') return isNoise(content) ? [] : [`USER: ${clip(content)}`];
    return content.filter((b) => b.type === 'text' && !isNoise(b.text)).map((b) => `USER: ${clip(b.text)}`);
  }
  if (entry.type === 'assistant' && !entry.isApiErrorMessage && Array.isArray(content)) {
    return content.flatMap((b) => (b.type === 'text' && b.text.trim() ? [`ASSISTANT: ${clip(b.text)}`] : b.type === 'tool_use' ? [toolLine(b.name, b.input)] : []));
  }
  return [];
}

function codexLines(entry) {
  const p = entry.payload;
  if (entry.type !== 'response_item' || !p) return [];
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = (p.content || []).map((c) => c.text ?? '').join('\n');
    if (!text.trim() || isNoise(text)) return [];
    return [`${p.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(text)}`];
  }
  if (p.type === 'function_call') return [toolLine(p.name, p.arguments)];
  if (p.type === 'custom_tool_call') return [`TOOL ${p.name}`];
  if (p.type === 'local_shell_call') return [toolLine('shell', p.action)];
  return [];
}

/** Text the tools add to user turns themselves (environment, instructions, command output). */
function isNoise(text) {
  const t = text.trimStart();
  return /^<(environment_context|user_instructions|skills_instructions|permissions instructions|command-name|command-message|local-command-stdout|system-reminder)/.test(t) || t.startsWith('# AGENTS.md instructions') || t.startsWith('Caveat:');
}
