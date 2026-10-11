// Runs the SeamlessAI server in the background, so nobody has to keep a
// terminal window open for it. The relay starts it when a free step needs
// it; `seamless stop` and `seamless status` manage it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, homeDir } from './config.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'seamless.js');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function serverPort() {
  return Number(process.env.SEAMLESS_PORT || DEFAULT_PORT);
}

function pidFile() {
  return path.join(homeDir(), 'server.pid');
}

export function logFile() {
  return path.join(homeDir(), 'server.log');
}

/** Whether a SeamlessAI server answers on the port. */
export async function isRunning(port = serverPort()) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const json = await res.json();
    return json.ok === true && Array.isArray(json.providers);
  } catch {
    return false;
  }
}

/** Starts the server in the background unless one is already running. Resolves with true if it started now. */
export async function ensureRunning(port = serverPort()) {
  if (await isRunning(port)) return false;
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(logFile()).size > MAX_LOG_BYTES) fs.truncateSync(logFile(), 0);
  } catch {}
  const log = fs.openSync(logFile(), 'a');
  const child = spawn(process.execPath, [BIN, 'start', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  child.unref();
  fs.writeFileSync(pidFile(), String(child.pid));

  let exited = null;
  child.once('exit', (code) => (exited = code));
  for (let i = 0; i < 50; i++) {
    if (await isRunning(port)) return true;
    if (exited !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`SeamlessAI did not start. The last lines of ${logFile()} say:\n${lastLines(logFile(), 8)}`);
}

/** Stops a server started in the background. Resolves with what happened, for the user. */
export async function stop(port = serverPort()) {
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile(), 'utf8'));
  } catch {}
  const running = await isRunning(port);
  fs.rmSync(pidFile(), { force: true });
  // Only a server that is actually up is stopped, so a stale file can't
  // point at some other program that later got the same process id.
  if (pid && running) {
    try {
      process.kill(pid);
    } catch {}
    for (let i = 0; i < 20 && (await isRunning(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }
  if (await isRunning(port)) return `SeamlessAI is still running on port ${port}, but it wasn't started in the background. Close the window it runs in.`;
  return pid && running ? 'SeamlessAI stopped.' : 'SeamlessAI was not running.';
}

function lastLines(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '(no log)';
  }
}
