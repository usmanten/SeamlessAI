// `seamless setup`: a one-time guided setup. It checks what is installed,
// saves free provider keys, picks the relay order, prepares Codex, starts
// SeamlessAI in the background and checks a free model answers.

import { loadCatalog, loadConfig, saveConfig, keyFor } from './config.js';
import { STEPS, defaultOrder, parseOrder, findCommand, ensureCodexProfile } from './relay.js';
import { ensureRunning, serverPort } from './background.js';

// Providers worth a key, best first, with why.
const SUGGESTED = [
  ['nvidia', 'the most dependable for Claude Code and Codex'],
  ['groq', 'the fastest for short questions'],
];

export async function setup({ ask, log = console.log }) {
  log('SeamlessAI setup\n');

  const [major] = process.versions.node.split('.').map(Number);
  log(`✓ Node.js ${process.versions.node}${major < 20 ? ' (too old: SeamlessAI needs 20 or newer, from https://nodejs.org)' : ''}`);
  const installed = { claude: Boolean(findCommand('claude')), codex: Boolean(findCommand('codex')) };
  log(`${installed.claude ? '✓' : '–'} Claude Code ${installed.claude ? 'found' : 'not found (install it from https://claude.com/claude-code if you want it in the relay)'}`);
  log(`${installed.codex ? '✓' : '–'} Codex ${installed.codex ? 'found' : 'not found (install it with `npm install -g @openai/codex` if you want it in the relay)'}`);

  // 1. Free provider keys.
  const catalog = loadCatalog();
  const config = loadConfig();
  config.keys = config.keys || {};
  log('\nFree provider keys. Each takes a couple of minutes to get and none asks for a card.');
  for (const [id, why] of SUGGESTED) {
    const provider = catalog.providers.find((p) => p.id === id);
    if (!provider) continue;
    if (keyFor(provider, config)) {
      log(`✓ ${provider.name} key already saved`);
      continue;
    }
    log(`\n${provider.name} (${why}): get a key at ${provider.auth.signupUrl}`);
    const key = (await ask(`Paste your ${provider.name} key, or press Enter to skip: `)).trim();
    if (key) {
      config.keys[id] = key;
      log(`✓ Saved ${provider.name} key`);
    }
  }
  saveConfig(config);

  // 2. Relay order.
  const suggested = defaultOrder((tool) => installed[tool]);
  const current = config.relay?.order?.length ? config.relay.order : suggested;
  log('\n`seamless code` runs your coding tools in this order, moving to the next when one runs out:');
  current.forEach((id, n) => log(`  ${n + 1}. ${STEPS[id].label} (${id})`));
  for (;;) {
    const answer = (await ask(`Press Enter to keep this order, or type a new one (for example: codex, claude, claude-free): `)).trim();
    if (!answer) {
      saveOrder(current);
      break;
    }
    try {
      saveOrder(parseOrder(answer));
      break;
    } catch (err) {
      log(err.message);
    }
  }

  // 3. Codex's free-model profile (a separate file; Codex's own settings aren't changed).
  if (installed.codex) {
    const { file, written } = ensureCodexProfile(serverPort());
    log(written ? `✓ Added a "seamless" profile for Codex (${file})` : `– ${file} already exists and wasn't written by SeamlessAI, so it was left alone`);
  }

  // 4. Start in the background and check a free model answers.
  log('\nStarting SeamlessAI in the background...');
  try {
    await ensureRunning();
    const res = await fetch(`http://127.0.0.1:${serverPort()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', max_tokens: 20, messages: [{ role: 'user', content: 'Reply with just the word ready.' }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    log(`✓ A free model answered (${res.headers.get('x-seamless-provider')})`);
  } catch (err) {
    log(`! The check didn't work: ${err.message}`);
    log('  Run `seamless providers` to see what is missing, then `seamless setup` again.');
    return;
  }

  log('\nAll set. In your project folder, run:\n\n  seamless code\n');
  log('SeamlessAI keeps running in the background. `seamless status` checks on it, `seamless stop` turns it off.');
}

function saveOrder(order) {
  const config = loadConfig();
  config.relay = { ...(config.relay || {}), order };
  saveConfig(config);
}
