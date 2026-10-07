import { DEFAULT_PORT, loadCatalog, loadConfig, saveConfig, keyFor, loadProbes, saveProbes } from './config.js';
import { probeTarget, TESTS } from './probe.js';
import { Router, AllProvidersFailed } from './router.js';
import { createServer, isLoopback } from './server.js';

const HELP = `seamless: keep coding on free AI providers when your credits run out

Usage:
  seamless start [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--quiet]
      Run a local OpenAI-compatible endpoint at http://127.0.0.1:${DEFAULT_PORT}/v1
      Use model "auto" to let SeamlessAI pick, or "<provider>" / "<provider>/<model>"
      to prefer one (the rest still act as fallback).

  seamless ask "<prompt>" [--model auto]
      Send one prompt through the fallback chain and print the answer.

  seamless providers
      List providers, which ones are usable, and how to get keys.

  seamless test [<provider> | <provider>/<model>,...] [--only tool-call,basic]
      Run the model test suite against your usable models and save the
      scores, which SeamlessAI then uses to rank models.

  seamless private on | off
      Private mode skips providers that may log or train on your prompts.

  seamless keys set <provider> <key>
  seamless keys remove <provider>
      Save or delete a provider API key in ~/.seamless/config.json.
      Environment variables (e.g. GROQ_API_KEY) take precedence.
`;

export async function main(argv) {
  const [command, ...rest] = argv;
  const { flags, args } = parseArgs(rest);
  switch (command) {
    case 'start':
      return start(flags);
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

function start(flags) {
  const port = Number(flags.port || process.env.SEAMLESS_PORT || DEFAULT_PORT);
  const host = flags.host || '127.0.0.1';
  const log = flags.quiet ? () => {} : (line) => console.log(line);
  const router = new Router({ catalog: loadCatalog(), config: loadConfig(), probes: loadProbes(), log });

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

function keys([action, providerId, key]) {
  const catalog = loadCatalog();
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (!['set', 'remove'].includes(action) || !provider || (action === 'set' && !key)) {
    console.error('Usage: seamless keys set <provider> <key> | seamless keys remove <provider>');
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
