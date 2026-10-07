import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/router.js';
import { probeTarget } from '../src/probe.js';
import { fakeModel, smartAnswer, catalogOf } from './helpers.js';

const open = [];
async function model(answer) {
  const m = await fakeModel(answer);
  open.push(m);
  return m;
}
after(() => open.forEach((m) => m.close()));

function routerFor(upstream, extra, modelExtra) {
  const router = new Router({ catalog: catalogOf(['p', upstream, extra, modelExtra]), config: { keys: {} } });
  return { router, target: router.targets()[0] };
}

test('a model that gets everything right scores 100', async () => {
  const m = await model(smartAnswer);
  const { router, target } = routerFor(m);
  const result = await probeTarget(router, target);
  assert.deepEqual(result.results.map((r) => [r.test, r.status]), [
    ['basic', 'pass'],
    ['tool-call', 'pass'],
    ['tool-loop', 'pass'],
    ['code-fix', 'pass'],
    ['long-input', 'pass'],
  ]);
  assert.equal(result.score, 100);
  assert.equal(result.id, 'p/p-model');

  // The tool loop really fed results back: multiply got add's answer.
  const loop = m.requests.filter((r) => String(r.body.messages[0].content).includes('(3 + 4)'));
  assert.equal(loop.length, 3);
  assert.equal(loop[2].body.messages.at(-1).content, '35');
  assert.ok(m.requests.every((r) => r.body.stream === false));
  // The model's own assistant turn goes back unchanged, extra fields included.
  assert.equal(loop[1].body.messages[1].tool_calls[0].id, 'call_add');
  assert.equal(loop[1].body.messages[1].reasoning_content, 'thinking');
});

test('wrong answers fail with a readable reason', async () => {
  const m = await model(() => ({ content: 'I am not sure.' }));
  const { router, target } = routerFor(m);
  const result = await probeTarget(router, target);
  assert.equal(result.score, 0);
  assert.equal(result.ran, 5);
  assert.match(result.results.find((r) => r.test === 'tool-call').detail, /no tool call/);
});

test('a missing model fails once and skips the rest instead of spending quota', async () => {
  const m = await model(() => ({ status: 404, error: 'model not found' }));
  const { router, target } = routerFor(m);
  const result = await probeTarget(router, target);
  assert.equal(m.requests.length, 1);
  assert.equal(result.ran, 1);
  assert.equal(result.score, 0);
  assert.match(result.results[0].detail, /404 model not found/);
  assert.ok(result.results.slice(1).every((r) => r.status === 'skipped' && /unreachable/.test(r.detail)));
});

test('a 200 with an error inside counts as a failure, not a pass', async () => {
  const m = await model(() => ({ content: 'PONG' }));
  const { router, target } = routerFor(m);
  // Answer 200 with an error in the body, like Kilo does when overloaded.
  router.fetch = async () => new Response(JSON.stringify({ error: { message: 'Upstream overloaded', code: 503 } }), { status: 200 });
  const result = await probeTarget(router, target, { only: ['basic'] });
  assert.equal(result.results[0].status, 'fail');
  assert.match(result.results[0].detail, /overloaded/);
});

test('rate limits skip tests rather than failing the model', async () => {
  const m = await model(() => ({ status: 429 }));
  const { router, target } = routerFor(m);
  const result = await probeTarget(router, target, { only: ['basic', 'code-fix'] });
  assert.equal(result.score, null);
  assert.ok(result.results.every((r) => r.status === 'skipped'));
});

test('waits out a short per-minute limit instead of skipping', async () => {
  const m = await model(smartAnswer);
  let clock = 1_000_000;
  const router = new Router({ catalog: catalogOf(['p', m, { limits: { rpm: 1, scope: 'model' } }]), config: { keys: {} }, now: () => clock });
  const slept = [];
  const result = await probeTarget(router, router.targets()[0], {
    only: ['basic', 'code-fix', 'long-input'],
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  assert.equal(result.score, 100);
  assert.equal(slept.length, 2);
});

test('skips the long test when the model context is too small, and tool tests for models without tools', async () => {
  const m = await model(smartAnswer);
  const { router, target } = routerFor(m, {}, { context: 2000, tools: false });
  const result = await probeTarget(router, target);
  const status = Object.fromEntries(result.results.map((r) => [r.test, r.status]));
  assert.deepEqual(status, { basic: 'pass', 'tool-call': 'skipped', 'tool-loop': 'skipped', 'code-fix': 'pass', 'long-input': 'skipped' });
  assert.equal(result.score, null, 'two tests are too few to score');
});

test('a model that keeps timing out is given up on after two tries', async () => {
  const m = await model(() => ({ content: 'PONG' }));
  const { router, target } = routerFor(m);
  router.fetch = async () => {
    throw new DOMException('Upstream timed out', 'TimeoutError');
  };
  const result = await probeTarget(router, target);
  assert.deepEqual(result.results.map((r) => r.status), ['fail', 'fail', 'skipped', 'skipped', 'skipped']);
  assert.equal(result.score, 0);
});

test('a request too large for a provider limit is skipped, not failed', async () => {
  const m = await model(() => ({ status: 413, error: 'Request too large: Limit 7000, Requested 7037' }));
  const { router, target } = routerFor(m);
  const result = await probeTarget(router, target, { only: ['long-input'] });
  assert.equal(result.results[0].status, 'skipped');
  assert.match(result.results[0].detail, /too large/);
});

test('tool arguments are treated as data, never run', async () => {
  const m = await model((body) => {
    const tools = body.messages.filter((x) => x.role === 'tool');
    if (tools.length === 0) {
      return { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":"process.exit(1)","b":2}' } }] };
    }
    return { content: 'done' };
  });
  const { router, target } = routerFor(m);
  const result = await probeTarget(router, target, { only: ['tool-loop'] });
  assert.equal(m.requests[1].body.messages.at(-1).content, 'error: a and b must be numbers');
  assert.equal(result.results[0].status, 'fail');
});
