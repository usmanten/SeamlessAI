import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Router, parseRetryAfter } from '../src/router.js';
import { createServer } from '../src/server.js';

// Fake upstream providers. Each one answers according to `behavior`, which a
// test can change between requests.
const upstreams = [];

async function fakeProvider(behavior) {
  const state = { behavior, requests: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push({ body, auth: req.headers.authorization });
    const b = state.behavior;
    if (b === 'ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: `hi from ${body.model}` } }] }));
    } else if (b === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else if (b === 'ok-but-error') {
      // What Kilo sends when the model behind it is overloaded.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream error from Nvidia: Service temporarily overloaded', code: 503 } }));
    } else if (b === 'stream-error') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ error: { message: 'rate limited upstream', code: 429 } })}\n\n`);
    } else if (b === 'hang') {
      // never answers
    } else {
      const status = Number(b);
      const headers = { 'content-type': 'application/json' };
      if (status === 429) headers['retry-after'] = '120';
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: { message: `fake ${status}` } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => {
    server.closeAllConnections();
    server.close();
  };
  upstreams.push(state);
  return state;
}

after(() => upstreams.forEach((u) => u.close()));

function catalogFor(...providers) {
  return {
    providers: providers.map(([id, upstream, extra = {}]) => ({
      id,
      name: id,
      baseUrl: upstream.url,
      auth: { required: false },
      models: [{ id: `${id}-model` }],
      ...extra,
    })),
  };
}

function chat(model = 'auto', extra = {}) {
  return { model, messages: [{ role: 'user', content: 'hello' }], ...extra };
}

test('falls back to the next provider on 429 and benches the limited one', async () => {
  const a = await fakeProvider('429');
  const b = await fakeProvider('ok');
  let clock = 1_000_000;
  const router = new Router({ catalog: catalogFor(['a', a], ['b', b]), config: { keys: {} }, now: () => clock });

  const first = await router.dispatch(chat());
  assert.equal(first.target.provider.id, 'b');
  assert.equal((await first.response.json()).choices[0].message.content, 'hi from b-model');
  assert.equal(b.requests[0].body.model, 'b-model', 'model is rewritten to the upstream id');

  // a is benched for its retry-after (120s), so it is not even tried.
  await router.dispatch(chat());
  assert.equal(a.requests.length, 1);

  clock += 121_000;
  a.behavior = 'ok';
  const later = await router.dispatch(chat());
  assert.equal(later.target.provider.id, 'a');
});

test('falls back on server errors and unreachable providers', async () => {
  const broken = await fakeProvider('503');
  const ok = await fakeProvider('ok');
  const dead = { url: 'http://127.0.0.1:1/v1' };
  const router = new Router({ catalog: catalogFor(['dead', dead], ['broken', broken], ['ok', ok]), config: { keys: {} } });
  const { target, attempts } = await router.dispatch(chat());
  assert.equal(target.provider.id, 'ok');
  assert.deepEqual(attempts.map((x) => x.target), ['dead/dead-model', 'broken/broken-model']);
});

test('falls back when a provider times out', async () => {
  const slow = await fakeProvider('hang');
  const ok = await fakeProvider('ok');
  const router = new Router({ catalog: catalogFor(['slow', slow], ['ok', ok]), config: { keys: {} }, timeoutMs: 200 });
  const { target, attempts } = await router.dispatch(chat());
  assert.equal(target.provider.id, 'ok');
  assert.equal(attempts[0].error, 'timed out');
});

test('a 200 with an error in the body counts as a failure and falls back', async () => {
  const sneaky = await fakeProvider('ok-but-error');
  const ok = await fakeProvider('ok');
  const router = new Router({ catalog: catalogFor(['sneaky', sneaky], ['ok', ok]), config: { keys: {} } });
  const { target, attempts, response } = await router.dispatch(chat());
  assert.equal(target.provider.id, 'ok');
  assert.equal(attempts[0].status, 503);
  assert.match(attempts[0].error, /overloaded/);
  assert.equal((await response.json()).choices[0].message.content, 'hi from ok-model', 'inspected body is still readable');

  // Benched like any other 503, so the next request skips it.
  await router.dispatch(chat());
  assert.equal(sneaky.requests.length, 1);
});

test('a stream whose first event is an error falls back; a good stream passes through intact', async () => {
  const bad = await fakeProvider('stream-error');
  const good = await fakeProvider('stream');
  const router = new Router({ catalog: catalogFor(['bad', bad], ['good', good]), config: { keys: {} } });
  const { target, attempts, response } = await router.dispatch(chat('auto', { stream: true }));
  assert.equal(target.provider.id, 'good');
  assert.equal(attempts[0].status, 429);
  const text = await response.text();
  assert.match(text, /"hel"/);
  assert.match(text, /"lo"/);
  assert.match(text, /\[DONE\]/);
});

test('a 400 moves on without benching the provider', async () => {
  const picky = await fakeProvider('400');
  const ok = await fakeProvider('ok');
  const router = new Router({ catalog: catalogFor(['picky', picky], ['ok', ok]), config: { keys: {} } });
  await router.dispatch(chat());
  picky.behavior = 'ok';
  const { target } = await router.dispatch(chat());
  assert.equal(target.provider.id, 'picky');
});

test('skips providers that need a key when none is set, and sends the key when it is', async () => {
  const keyed = await fakeProvider('ok');
  const open = await fakeProvider('ok');
  const catalog = catalogFor(['keyed', keyed, { auth: { required: true, env: 'SEAMLESS_TEST_KEY' } }], ['open', open]);

  const without = new Router({ catalog, config: { keys: {} } });
  assert.equal((await without.dispatch(chat())).target.provider.id, 'open');

  const withKey = new Router({ catalog, config: { keys: { keyed: 'sk-test' } } });
  assert.equal((await withKey.dispatch(chat())).target.provider.id, 'keyed');
  assert.equal(keyed.requests[0].auth, 'Bearer sk-test');
  assert.equal(open.requests[0].auth, undefined);
});

test('a requested provider goes first and the rest stay as fallback', async () => {
  const a = await fakeProvider('ok');
  const b = await fakeProvider('429');
  const router = new Router({ catalog: catalogFor(['a', a], ['b', b]), config: { keys: {} } });
  assert.deepEqual(router.plan('b').map((t) => t.id), ['b/b-model', 'a/a-model']);
  assert.deepEqual(router.plan('b-model').map((t) => t.id), ['b/b-model', 'a/a-model']);
  const { target } = await router.dispatch(chat('b'));
  assert.equal(target.provider.id, 'a');
});

test('stays under published rpm limits without waiting for a 429', async () => {
  const a = await fakeProvider('ok');
  const b = await fakeProvider('ok');
  const router = new Router({ catalog: catalogFor(['a', a, { limits: { rpm: 2, scope: 'model' } }], ['b', b]), config: { keys: {} } });
  const used = [];
  for (let i = 0; i < 3; i++) used.push((await router.dispatch(chat())).target.provider.id);
  assert.deepEqual(used, ['a', 'a', 'b']);
});

test('server streams through, labels the provider, and reports exhaustion as 429', async () => {
  const limited = await fakeProvider('429');
  const streamer = await fakeProvider('stream');
  const router = new Router({ catalog: catalogFor(['limited', limited], ['streamer', streamer]), config: { keys: {} } });
  const server = createServer(router);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const models = await (await fetch(`${base}/models`)).json();
    assert.deepEqual(models.data.map((m) => m.id), ['auto', 'limited/limited-model', 'streamer/streamer-model']);

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: JSON.stringify(chat('auto', { stream: true })),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-seamless-provider'), 'streamer');
    assert.match(res.headers.get('content-type'), /event-stream/);
    const text = await res.text();
    assert.match(text, /"hel"/);
    assert.match(text, /\[DONE\]/);

    streamer.behavior = '429';
    const exhausted = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chat()),
    });
    assert.equal(exhausted.status, 429);
    assert.ok(Number(exhausted.headers.get('retry-after')) > 0);
    assert.equal((await exhausted.json()).error.code, 'all_providers_exhausted');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('parses retry-after in seconds and as a date', () => {
  assert.equal(parseRetryAfter('30', 0), 30_000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(parseRetryAfter('soon', 0), null);
});
