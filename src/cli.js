import { DEFAULT_PORT, loadCatalog, loadConfig, saveConfig, keyFor } from './config.js';
import { Router, AllProvidersFailed } from './router.js';
import { createServer } from './server.js';

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
  const router = new Router({ catalog: loadCatalog(), config: loadConfig(), log });

  const usable = router.status().filter((p) => p.usable);
  if (usable.length === 0) {
    console.error('No providers are usable. Run `seamless providers` to see what is missing.');
    process.exitCode = 1;
    return;
  }

  const server = createServer(router, { log });
  server.listen(port, host, () => {
    console.log(`SeamlessAI listening on http://${host}:${port}/v1`);
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
  const router = new Router({ catalog: loadCatalog(), config: loadConfig(), log: (l) => console.error(l) });
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
    if (p.mayLogPrompts) console.log('           note: this provider may log prompts');
  }
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
