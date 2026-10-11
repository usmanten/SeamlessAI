import { DEFAULT_PORT, loadCatalog, loadConfig, liveConfig, saveConfig, keyFor, loadProbes, saveProbes } from './config.js';
import { probeTarget, TESTS } from './probe.js';
import { Router, AllProvidersFailed } from './router.js';
import { createServer, isLoopback } from './server.js';
import { STEPS, FREE_MODES, relay, relayOrder, parseOrder, defaultOrder, freeMode } from './relay.js';
import { ensureRunning, isRunning, stop, serverPort, logFile } from './background.js';
import { summarizeWith } from './handoff.js';
import { setup } from './setup.js';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';

const { version: VERSION } = createRequire(import.meta.url)('../package.json');

const HELP = `seamless: keep coding on free AI providers when your credits run out

Usage:
  seamless setup
      One-time guided setup: keys, the relay order, and a quick check.

  seamless code [--from <step>]
      Run your coding tools one after another in this folder: each on your
      own account, then on free models. When one runs out of usage,
      SeamlessAI switches to the next and carries the work over.

  seamless relay [<step>, <step>, ...] [--free-mode edits|ask|auto]
      Show or set the order \`seamless code\` uses. Steps: ${Object.keys(STEPS).join(', ')}
      --free-mode sets how Claude Code asks permission on free models:
      edits (default) lets file edits through and asks before commands, ask
      asks before both, auto has a free model check each tool call.

  seamless start [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--quiet] [--background]
      Run a local OpenAI-compatible endpoint at http://127.0.0.1:${DEFAULT_PORT}/v1
      Use model "auto" to let SeamlessAI pick, or "<provider>" / "<provider>/<model>"
      to prefer one (the rest still act as fallback). --background runs it
      without keeping this window open.

  seamless status | seamless stop
      Check on, or stop, SeamlessAI running in the background.

  seamless ask "<prompt>" [--model auto]
      Send one prompt through the fallback chain and print the answer.

  seamless providers
      List providers, which ones are usable, and how to get keys.

  seamless test [<provider> | <provider>/<model>,...] [--only tool-call,basic]
      Run the model test suite against your usable models and save the
      scores, which SeamlessAI then uses to rank models.

  seamless private on | off
      Private mode skips providers that may log or train on your prompts.

  seamless trim [auto [<seconds>] | wait | off]
      What to do when a conversation is too big for every model that is
      free right now. auto (default): wait if a model with room is back
      within <seconds> (default 60), otherwise trim old tool output and
      files. wait: always wait for a model with room; trim only if none
      could ever fit. off: never trim.

  seamless keys set <provider> [<key>]
  seamless keys remove <provider>
      Save or delete a provider API key in ~/.seamless/config.json. Leave
      out <key> to paste it without it showing or staying in your history.
      Environment variables (e.g. GROQ_API_KEY) take precedence.

  seamless --version
      Print the installed version.
`;

export async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, args } = parseArgs(rest);
  switch (command) {
    case 'setup':
      return setup({ ask: question, askSecret: (text) => (process.stdin.isTTY ? hiddenQuestion(text) : question(text)) });
    case 'code':
      return code(flags);
    case 'relay':
      return relayCommand(args, flags);
    case 'start':
      if (flags.background) return background(flags);
      return start(flags);
    case 'status':
      return status();
    case 'stop':
      return console.log(await stop());
    case 'ask':
      return ask(args.join(' '), flags);
    case 'providers':
      return providers();
    case 'keys':
      return keys(args);
    case 'test':
      return testModels(args[0], flags);
    case 'private':
      return privateMode(args[0]);
    case 'trim':
      return trimSetting(args);
    case 'version':
    case '--version':
    case '-v':
      return console.log(VERSION);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return console.log(HELP);
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

async function code(flags) {
  const port = serverPort();
  if (flags.from !== undefined && !STEPS[flags.from]) {
    console.error(flags.from === true ? `--from needs a step. Steps: ${Object.keys(STEPS).join(', ')}` : `Unknown step "${flags.from}". Steps: ${Object.keys(STEPS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const order = relayOrder();
  if (order.length === 0) {
    console.error('Neither Claude Code nor Codex is installed. Install one of them, then run `seamless setup`.');
    process.exitCode = 1;
    return;
  }
  console.log(`Relay order: ${order.map((id) => STEPS[id].label).join(' → ')}`);
  await relay({
    order,
    from: typeof flags.from === 'string' ? flags.from : undefined,
    port,
    ask: question,
    ensureServer: () => ensureRunning(port),
    summarize: summarizeWith(port),
  });
}

function relayCommand(args, flags = {}) {
  const setMode = flags['free-mode'];
  if (setMode !== undefined && !FREE_MODES[setMode]) {
    console.error(`Unknown free mode "${setMode}". Modes: ${Object.keys(FREE_MODES).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (setMode) {
    const config = loadConfig();
    config.relay = { ...(config.relay || {}), freeMode: setMode };
    saveConfig(config);
  }
  if (args.length) {
    let order;
    try {
      order = parseOrder(args.join(' '));
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    config.relay = { ...(config.relay || {}), order };
    saveConfig(config);
  }
  const config = loadConfig();
  const order = relayOrder(config);
  console.log(`${args.length || setMode ? 'Saved. ' : ''}\`seamless code\` runs, in order:`);
  order.forEach((id, n) => console.log(`  ${n + 1}. ${STEPS[id].label} (${id})`));
  if (!config.relay?.order?.length) console.log(`(the default for what is installed; set your own with \`seamless relay ${defaultOrder().join(', ') || 'claude, claude-free'}\`)`);
  if (order.includes('claude-free')) console.log(`Claude Code on free models runs in ${freeMode(config)} mode (change with \`seamless relay --free-mode edits|ask|auto\`).`);
  const out = Object.entries(config.relayOut || {}).filter(([, until]) => until > Date.now());
  for (const [id, until] of out) console.log(`${STEPS[id]?.label ?? id} is out of usage until ${new Date(until).toLocaleTimeString()}.`);
}

async function background(flags) {
  const port = Number(flags.port) || serverPort();
  const started = await ensureRunning(port);
  console.log(`${started ? 'SeamlessAI is now running in the background' : 'SeamlessAI was already running'} at http://127.0.0.1:${port}/v1`);
  console.log(`Log: ${logFile()}. \`seamless stop\` turns it off.`);
}

async function status() {
  if (await isRunning()) console.log(`SeamlessAI is running at http://127.0.0.1:${serverPort()}/v1 (log: ${logFile()}).`);
  else console.log('SeamlessAI is not running. `seamless code` starts it when needed, or run `seamless start --background`.');
}

/** Asks a question in the terminal; with no terminal, answers with an empty line. */
async function question(text) {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${text}\n`);
    return '';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(text);
  } finally {
    rl.close();
  }
}

/** Like question, but what is typed isn't shown. Needs a terminal. */
function hiddenQuestion(text) {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    let answer = '';
    process.stdout.write(text);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(answer);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') answer = answer.slice(0, -1);
        else if (ch >= ' ') answer += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function start(flags) {
  const port = Number(flags.port || process.env.SEAMLESS_PORT || DEFAULT_PORT);
  const host = flags.host || '127.0.0.1';
  const log = flags.quiet ? () => {} : (line) => console.log(line);
  // Settings saved while the server runs (keys, private mode, trim) apply to the next request.
  const router = new Router({ catalog: loadCatalog(), getConfig: liveConfig(), probes: loadProbes(), log });

  const usable = router.status().filter((p) => p.usable);
  if (usable.length === 0) {
    console.error('No providers are usable. Run `seamless providers` to see what is missing.');
    process.exitCode = 1;
    return;
  }

  if (!isLoopback(host)) console.warn(`Warning: listening on ${host} lets other devices on your network use your provider keys.`);
  const server = createServer(router, { log, localOnly: isLoopback(host) });
  server.listen(port, host, () => {
    console.log(`SeamlessAI listening on http://${host}:${port}/v1`);
    if (loadConfig().privateMode) console.log('Private mode is on: providers that may log or train on prompts are skipped.');
    console.log(`Fallback order: ${router.targets().map((t) => t.id).join(' → ')}`);
    console.log('Point your tool at that base URL with any API key and model "auto".');
    console.log(`For Claude Code, set ANTHROPIC_BASE_URL=http://${host}:${port} and ANTHROPIC_AUTH_TOKEN=seamless.`);
  });
  return new Promise((resolve) => server.on('close', resolve));
}

async function ask(prompt, flags) {
  if (!prompt) {
    console.error('Usage: seamless ask "<prompt>"');
    process.exitCode = 1;
    return;
  }
  const router = new Router({ catalog: loadCatalog(), config: loadConfig(), probes: loadProbes(), log: (l) => console.error(l) });
  try {
    const { response, target } = await router.dispatch({
      model: flags.model || 'auto',
      messages: [{ role: 'user', content: prompt }],
    });
    const data = await response.json();
    console.log(data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2));
    console.error(`(answered by ${target.id})`);
  } catch (err) {
    if (!(err instanceof AllProvidersFailed)) throw err;
    console.error(err.attempts.length ? err.message : 'No providers are usable. Run `seamless providers`.');
    process.exitCode = 1;
  }
}

function providers() {
  const catalog = loadCatalog();
  const config = loadConfig();
  for (const p of catalog.providers) {
    const needsKey = p.auth?.required;
    const hasKey = Boolean(keyFor(p, config));
    const state = !needsKey ? 'ready (no key needed)' : hasKey ? 'ready (key set)' : 'needs key';
    console.log(`${p.id.padEnd(10)} ${state}`);
    console.log(`           ${p.name} · ${p.models.map((m) => m.id).join(', ')}`);
    if (needsKey && !hasKey) {
      console.log(`           get a free key at ${p.auth.signupUrl}, then: seamless keys set ${p.id} <key>`);
    }
    if (p.mayLogPrompts || p.trainsOnPrompts) console.log(`           note: this provider may ${p.trainsOnPrompts ? 'train on' : 'log'} prompts (skipped in private mode)`);
    if (p.termsNote) console.log(`           terms: ${p.termsNote}`);
  }
}

async function testModels(filter, flags) {
  // Big models can take a while to answer the longer tests.
  const router = new Router({ catalog: loadCatalog(), config: loadConfig(), timeoutMs: 180_000 });
  const wanted = typeof filter === 'string' ? filter.split(',') : null;
  const targets = router.targets().filter((t) => !wanted || wanted.includes(t.id) || wanted.includes(t.provider.id));
  if (targets.length === 0) {
    console.error(filter ? `No usable model matches "${filter}". See \`seamless providers\`.` : 'No providers are usable. Run `seamless providers`.');
    process.exitCode = 1;
    return;
  }
  const only = typeof flags.only === 'string' ? flags.only.split(',') : undefined;
  const unknown = (only || []).filter((id) => !TESTS.some((t) => t.id === id));
  if (unknown.length) {
    console.error(`Unknown test(s): ${unknown.join(', ')}. Tests: ${TESTS.map((t) => t.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Testing ${targets.length} model(s): ${TESTS.filter((t) => !only || only.includes(t.id)).map((t) => t.id).join(', ')}`);
  console.log('Only made-up test prompts are sent. Slow or rate-limited providers can take a few minutes.\n');
  const saved = {};
  for (const target of targets) {
    process.stdout.write(`${target.id} … `);
    const result = await probeTarget(router, target, { only });
    saved[target.id] = result;
    saveProbes({ [target.id]: result }); // save as we go, so an interrupted run keeps what it has
    console.log(result.score === null ? `not enough tests ran to score (${result.ran} of ${result.results.length})` : `${result.score}/100 (${result.passed}/${result.ran} passed${result.avgMs ? `, ~${(result.avgMs / 1000).toFixed(1)}s each` : ''})`);
    for (const r of result.results) {
      const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '–';
      console.log(`    ${mark} ${r.test.padEnd(11)}${r.detail ? ` ${r.detail}` : ''}`);
    }
  }
  console.log('\nSaved to ~/.seamless/probes.json. `seamless start` now ranks models with these scores.');
}

function trimSetting([mode, seconds]) {
  const config = loadConfig();
  if (mode === undefined) {
    const current = config.trim ?? 'auto';
    const wait = config.trimWaitSeconds ?? 60;
    return console.log(`Trim mode: ${current}${current === 'auto' ? ` (waits up to ${wait}s for a model with room)` : ''}`);
  }
  const wait = Number(seconds ?? 60);
  if (!['auto', 'wait', 'off'].includes(mode) || (seconds !== undefined && (mode !== 'auto' || !(wait >= 0)))) {
    console.error('Usage: seamless trim [auto [<seconds>] | wait | off]');
    process.exitCode = 1;
    return;
  }
  config.trim = mode;
  if (mode === 'auto') config.trimWaitSeconds = wait;
  saveConfig(config);
  console.log(
    {
      auto: `Trim mode auto: waits up to ${wait}s for a model with room for the whole conversation, otherwise trims old tool output and files.`,
      wait: 'Trim mode wait: always waits for a model with room for the whole conversation; trims only if none could ever fit.',
      off: 'Trim mode off: conversations are never trimmed; requests too big for every free model fail instead.',
    }[mode],
  );
}

function privateMode(value) {
  if (!['on', 'off'].includes(value)) {
    console.error('Usage: seamless private on | off');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  config.privateMode = value === 'on';
  saveConfig(config);
  console.log(config.privateMode ? 'Private mode on: providers that may log or train on prompts will be skipped.' : 'Private mode off.');
}

async function keys([action, providerId, key]) {
  const catalog = loadCatalog();
  const provider = catalog.providers.find((p) => p.id === providerId);
  // With the key left off, ask for it without showing it, so it stays out of
  // the terminal's history.
  if (action === 'set' && provider && !key && process.stdin.isTTY) key = (await hiddenQuestion(`Paste your ${provider.name} key (hidden): `)).trim();
  if (!['set', 'remove'].includes(action) || !provider || (action === 'set' && !key)) {
    console.error('Usage: seamless keys set <provider> [<key>] | seamless keys remove <provider>');
    console.error(`Providers: ${catalog.providers.map((p) => p.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  config.keys = config.keys || {};
  if (action === 'set') config.keys[provider.id] = key;
  else delete config.keys[provider.id];
  saveConfig(config);
  console.log(action === 'set' ? `Saved key for ${provider.name}.` : `Removed key for ${provider.name}.`);
}

function parseArgs(list) {
  const flags = {};
  const args = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[name] = inline;
      else if (list[i + 1] && !list[i + 1].startsWith('--')) flags[name] = list[++i];
      else flags[name] = true;
    } else args.push(a);
  }
  return { flags, args };
}
