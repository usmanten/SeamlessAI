import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Router, AllProvidersFailed, requestNeeds, safeForKey } from '../src/router.js';
import { createServer } from '../src/server.js';
import { fakeModel, catalogOf, chat } from './helpers.js';

const open = [];
async function model(answer = () => ({ content: 'hi' })) {
  const m = await fakeModel(answer);
  open.push(m);
  return m;
}
after(() => open.forEach((m) => m.close()));

const TOOLS = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];

test('tool requests skip models that cannot use tools', async () => {
  const noTools = await model();
  const withTools = await model();
  const router = new Router({ catalog: catalogOf(['plain', noTools, {}, { tools: false }], ['agent', withTools]), config: { keys: {} } });
  const { target, attempts } = await router.dispatch(chat({ tools: TOOLS }));
  assert.equal(target.provider.id, 'agent');
  assert.equal(attempts[0].skipped, 'model cannot use tools');
  assert.equal(noTools.requests.length, 0);

  // Without tools the plain model is fine.
  assert.equal((await router.dispatch(chat())).target.provider.id, 'plain');
});

test('requests too big for a context or a per-minute token limit go elsewhere', async () => {
  const small = await model();
  const tight = await model();
  const big = await model();
  const router = new Router({
    catalog: catalogOf(['small', small, {}, { context: 1000 }], ['tight', tight, { limits: { tpm: 2000 } }], ['big', big]),
    config: { keys: {} },
  });
  const long = chat({ messages: [{ role: 'user', content: 'x'.repeat(12_000) }] });
  const { target, attempts } = await router.dispatch(long);
  assert.equal(target.provider.id, 'big');
  assert.match(attempts[0].skipped, /bigger than its 1000-token context/);
  assert.match(attempts[1].skipped, /bigger than its 2000 tokens\/minute limit/);
});

test('token budgets fill up and free again after a minute', async () => {
  const a = await model();
  const b = await model();
  let clock = 1_000_000;
  const router = new Router({ catalog: catalogOf(['a', a, { limits: { tpm: 3000 } }], ['b', b]), config: { keys: {} }, now: () => clock });
  const medium = chat({ messages: [{ role: 'user', content: 'x'.repeat(6000) }] }); // ~1,500 tokens
  assert.equal((await router.dispatch(medium)).target.provider.id, 'a');
  clock += 1000;
  assert.equal((await router.dispatch(medium)).target.provider.id, 'b', 'a has no room left this minute');
  clock += 60_000;
  assert.equal((await router.dispatch(medium)).target.provider.id, 'a');
});

test('private mode skips providers that may log or train on prompts', async () => {
  const logger = await model();
  const quiet = await model();
  const catalog = catalogOf(['logger', logger, { mayLogPrompts: true }], ['quiet', quiet]);
  assert.equal((await new Router({ catalog, config: { keys: {} } }).dispatch(chat())).target.provider.id, 'logger');
  const { target, attempts } = await new Router({ catalog, config: { keys: {}, privateMode: true } }).dispatch(chat());
  assert.equal(target.provider.id, 'quiet');
  assert.match(attempts[0].skipped, /private mode/);
});

test('better tested models are tried first; an explicit choice still wins', async () => {
  const weak = await model();
  const strong = await model();
  const catalog = catalogOf(['weak', weak, {}, { tier: 'good' }], ['strong', strong]);
  const router = new Router({ catalog, config: { keys: {} }, probes: { 'strong/strong-model': { score: 100 } } });
  assert.deepEqual(router.plan('auto').map((t) => t.id), ['strong/strong-model', 'weak/weak-model']);
  assert.deepEqual(router.plan('weak').map((t) => t.id), ['weak/weak-model', 'strong/strong-model']);

  // Without test results the catalog tier decides.
  assert.equal(new Router({ catalog, config: { keys: {} } }).plan('auto')[0].id, 'weak/weak-model');
});

test('a model that keeps breaking drops down the ranking', async () => {
  const flaky = await model();
  const steady = await model();
  let clock = 1_000_000;
  const router = new Router({ catalog: catalogOf(['flaky', flaky], ['steady', steady]), config: { keys: {} }, now: () => clock });
  flaky.answer = () => ({ status: 503 });
  for (let i = 0; i < 3; i++) {
    await router.dispatch(chat());
    clock += 31_000; // past the 30s server-error bench
  }
  flaky.answer = () => ({ content: 'back' });
  assert.equal((await router.dispatch(chat())).target.provider.id, 'steady');
  assert.ok(router.score(router.targets()[0]).parts.reliability < 50);
});

test('rate limits do not count against reliability', async () => {
  const a = await model(() => ({ status: 429 }));
  const b = await model();
  const router = new Router({ catalog: catalogOf(['a', a], ['b', b]), config: { keys: {} } });
  await router.dispatch(chat());
  assert.equal(router.stats.get('a/a-model'), undefined);
});

test('keys are never sent over plain http to another machine', async () => {
  let called = false;
  const router = new Router({
    catalog: { providers: [{ id: 'remote', name: 'remote', baseUrl: 'http://example.com/v1', auth: { required: true }, models: [{ id: 'm' }] }] },
    config: { keys: { remote: 'sk-secret' } },
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });
  await assert.rejects(router.dispatch(chat()), (err) => err instanceof AllProvidersFailed && /plain http/.test(err.attempts[0].skipped));
  assert.equal(called, false);
  assert.equal(safeForKey('https://api.groq.com/openai/v1'), true);
  assert.equal(safeForKey('http://127.0.0.1:9/v1'), true);
  assert.equal(safeForKey('http://example.com/v1'), false);
});

test('estimates request size from messages, tools and the reply budget', () => {
  const need = requestNeeds({ messages: [{ role: 'user', content: 'x'.repeat(400) }], tools: TOOLS, max_tokens: 100 });
  assert.equal(need.tools, true);
  assert.ok(need.tokens > 200 && need.tokens < 250, `got ${need.tokens}`);
});

test('the server refuses requests from web pages and unexpected hosts', async () => {
  const m = await model();
  const server = createServer(new Router({ catalog: catalogOf(['p', m]), config: { keys: {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (headers) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(chat()) });
  try {
    assert.equal((await post({})).status, 200);
    assert.equal((await post({ origin: `http://localhost:3000` })).status, 200);
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ origin: 'null' })).status, 403);
    // fetch won't let us forge Host, so check it with a raw request.
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { host: `attacker.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.equal(m.requests.length, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
