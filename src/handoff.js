// The handoff note: when the relay moves from one tool to a different one
// (Codex to Claude Code, say), the new tool can't open the old one's
// conversation. So SeamlessAI boils the old session down, has a free model
// summarize it, and saves the summary in the project for the new tool to read.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './sessions.js';

export const HANDOFF_FILE = path.join('.seamless', 'handoff.md');

const SUMMARY_PROMPT = `You are writing a handoff note. A coding assistant was working in a software project and ran out of usage; a different coding assistant will take over and has never seen this conversation. Below is a log of the session (the user's requests, the assistant's replies, and one line per tool call; tool output is left out), then the project's uncommitted changes.

Write the note in Markdown with exactly these sections:
## Goal
What the user is building and what they asked for, in their words where possible.
## Done so far
What was finished, with file names.
## In progress
What was being worked on when the session stopped, and anything left half done.
## Next steps
A short numbered list of what to do next.
## Decisions and preferences
Choices the user made, constraints, and how they like to work. Leave out the section if there are none.

Be specific and brief. Do not invent anything that is not in the log.`;

/**
 * Writes .seamless/handoff.md in `cwd` from a tool's session file and
 * resolves with its path. `summarize(prompt)` asks a model and resolves with
 * its text; if it fails, the note carries the session log itself instead.
 */
export async function writeHandoff({ cwd, from, to, tool, file, summarize, log = () => {} }) {
  const sessionLog = file ? digest(tool, file) : '';
  const changes = gitChanges(cwd);
  let body = null;
  if (sessionLog && summarize) {
    try {
      body = (await summarize(`${SUMMARY_PROMPT}\n\n--- SESSION LOG ---\n${sessionLog}\n\n--- UNCOMMITTED CHANGES ---\n${changes || '(none, or not a git repository)'}`))?.trim() || null;
    } catch (err) {
      log(`Could not summarize the session (${err.message}); the note will carry the session log instead.`);
    }
  }
  if (!body) {
    body = sessionLog
      ? `## Session log\nA summary could not be written, so here is the end of the session: requests, replies and tool calls.\n\n\`\`\`\n${sessionLog.slice(-12_000)}\n\`\`\``
      : '## Session log\nThe previous session could not be found. Ask the user what they were working on.';
  }

  const note = [
    '# SeamlessAI handoff',
    '',
    `${from} ran out of usage on ${new Date().toLocaleString()}. ${to} takes over from here. Read this note, check the files it mentions, then carry on with the next steps.`,
    '',
    body,
    '',
    '## Uncommitted changes',
    changes ? `\`\`\`\n${changes}\n\`\`\`` : 'None, or this folder is not a git repository.',
    '',
  ].join('\n');

  const dir = path.join(cwd, '.seamless');
  fs.mkdirSync(dir, { recursive: true });
  // The folder ignores itself, so the note never ends up in a commit.
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  const target = path.join(cwd, HANDOFF_FILE);
  fs.writeFileSync(target, note);
  return target;
}

/** `git status --short` and `git diff --stat`, or '' outside a repository. */
function gitChanges(cwd) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    } catch {
      return '';
    }
  };
  const status = run(['status', '--short']);
  if (!status) return '';
  const stat = run(['diff', '--stat']);
  const text = stat ? `${status}\n\n${stat}` : status;
  return text.length > 4000 ? `${text.slice(0, 4000)}\n[...]` : text;
}

/** A summarize function that asks the local SeamlessAI server. */
export function summarizeWith(port) {
  return async (prompt) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(180_000),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    return json.choices?.[0]?.message?.content;
  };
}
