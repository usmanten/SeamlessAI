import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Router, AllProvidersFailed, requestNeeds } from '../src/router.js';
import { createServer } from '../src/server.js';
import { trimToFit, RECENT_MESSAGES } from '../src/trim.js';
import { fakeModel, catalogOf } from './helpers.js';

const open = [];
async function model(answer = () => ({ content: 'hi' })) {
  const m = await fakeModel(answer);
  open.push(m);
  return m;
}
after(() => open.forEach((m) => m.close()));

const estimate = (body) => requestNeeds(body).tokens;
const SYSTEM = { role: 'system', content: 'You are a coding agent. Follow the house style.' };

/**
 * An agent session: each turn asks something, reads a big file through a
 * tool, and answers. The last turn is the user's latest request.
 */
function session(turns, { output = 'log line\n'.repeat(500) } = {}) {
  const messages = [SYSTEM];
  for (let t = 0; t < turns; t++) {
    messages.push({ role: 'user', content: `request ${t}` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${t}`, type: 'function', function: { name: 'run', arguments: '{"cmd":"npm test"}' } }] });
    messages.push({ role: 'tool', tool_call_id: `call_${t}`, content: `output ${t}\n${output}` });
    messages.push({ role: 'assistant', content: `answer ${t}` });
  }
  messages.push({ role: 'user', content: 'latest request: fix the failing test' });
  return { model: 'auto', messages };
}

test('a conversation that already fits is left alone', () => {
  const body = session(2);
  const { body: out, report } = trimToFit(body, estimate(body), estimate);
  assert.equal(out, body);
  assert.equal(report, null);
});

test('old tool output goes first, oldest first, and only as much as needed', () => {
  const body = session(6);
  const limit = estimate(body) - 2000; // about two tool outputs' worth
  const { body: out, report } = trimToFit(body, limit, estimate);
  assert.ok(estimate(out) <= limit);
  assert.equal(report.toolOutputs, 2);
  assert.equal(report.droppedMessages, 0);
  const tools = out.messages.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /^\[SeamlessAI removed this old tool output .* It began: "output 0/);
  assert.match(tools[1].content, /SeamlessAI removed/);
  assert.match(tools[2].content, /^output 2/);
  // The caller's body is not changed.
  assert.match(body.messages[3].content, /^output 0/);
});

test('instructions, the latest request and recent messages are never touched', () => {
  const body = session(6);
  const { body: out } = trimToFit(body, 3000, estimate);
  assert.deepEqual(out.messages[0], SYSTEM);
  assert.deepEqual(out.messages.slice(-RECENT_MESSAGES), body.messages.slice(-RECENT_MESSAGES));
  assert.equal(out.messages.at(-1).content, 'latest request: fix the failing test');
});

test('old file contents are shortened: pasted code blocks and file writes', () => {
  const file = '```js\n' + 'const x = 1;\n'.repeat(300) + '```';
  const write = JSON.stringify({ path: 'big.js', content: 'y'.repeat(5000) });
  const body = {
    model: 'auto',
    messages: [
      SYSTEM,
      { role: 'user', content: `here is my file:\n${file}\nplease review it` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: write } }] },
      { role: 'tool', tool_call_id: 'w', content: 'written' },
      ...session(1).messages.slice(1),
    ],
  };
  const { body: out, report } = trimToFit(body, estimate(body) - 2500, estimate);
  assert.equal(report.fileContents, 2);
  assert.match(out.messages[1].content, /^here is my file:\n```js\n\[SeamlessAI removed \d+ characters of old file content/);
  assert.match(out.messages[1].content, /please review it$/);
  const args = JSON.parse(out.messages[2].tool_calls[0].function.arguments);
  assert.match(args.seamless_note, /removed these old arguments/);
});

test('when that is not enough, the oldest whole turns go, with a note', () => {
  const body = session(8, { output: 'short' });
  const limit = estimate(body) - 150;
  const { body: out, report } = trimToFit(body, limit, estimate);
  assert.ok(report.droppedMessages > 0);
  assert.equal(report.droppedMessages % 4, 0, 'whole turns only');
  assert.deepEqual(out.messages[0], SYSTEM);
  assert.equal(out.messages[1].role, 'system');
  assert.match(out.messages[1].content, new RegExp(`the ${report.droppedMessages} oldest messages were removed`));
  assert.equal(out.messages[2].role, 'user');
  // Every tool result still follows the call that asked for it.
  const calls = new Set(out.messages.flatMap((m) => (m.tool_calls || []).map((c) => c.id)));
  for (const m of out.messages.filter((m) => m.role === 'tool')) assert.ok(calls.has(m.tool_call_id));
  assert.equal(estimate(out), report.after);
  assert.ok(report.after <= limit);
});

test('gives up rather than cut what must be kept', () => {
  const body = session(1);
  body.messages.push({ role: 'user', content: 'z'.repeat(9000) });
  assert.equal(trimToFit(body, 1000, estimate), null);
});

test('step 1: a long conversation goes whole to a strong model with room, not a faster small one', async () => {
  const fast = await model();
  const roomy = await model();
  const router = new Router({
    catalog: catalogOf(['fast', fast, { limits: { tpm: 8000 } }, { tier: 'strong', avgMs: 300 }], ['roomy', roomy, {}, { tier: 'strong', context: 131072 }]),
    config: { keys: {} },
  });
  const body = session(10);
  const { target, trimmed } = await router.dispatch(body);
  assert.equal(target.provider.id, 'roomy');
  assert.equal(trimmed, undefined);
  assert.deepEqual(roomy.requests[0].body.messages, body.messages);
  assert.equal(fast.requests.length, 0);
});

test('step 2: when no model can take it whole, it is trimmed for the one with most room and announced', async () => {
  const tiny = await model();
  const small = await model();
  const lines = [];
  const router = new Router({
    catalog: catalogOf(['tiny', tiny, {}, { context: 2000, tier: 'strong' }], ['small', small, { limits: { tpm: 5000 } }]),
    config: { keys: {} },
    log: (l) => lines.push(l),
  });
  const server = createServer(router, { log: (l) => lines.push(l) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const body = session(8);
    assert.ok(estimate(body) > 5000);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-seamless-provider'), 'small');
    assert.match(res.headers.get('x-seamless-trimmed'), /old tool outputs shortened .*\(~\d+ -> ~\d+ tokens\)/);
    assert.ok(lines.some((l) => l.includes('✂ trimmed for small/small-model')));
    assert.equal(tiny.requests.length, 0);
    const sent = small.requests[0].body;
    assert.ok(estimate(sent) <= 5000);
    assert.deepEqual(sent.messages[0], SYSTEM);
    assert.equal(sent.messages.at(-1).content, 'latest request: fix the failing test');
  } finally {
    server.close();
  }
});

test('waits for a model with room that is back within a minute instead of trimming', async () => {
  const roomy = await model(() => ({ status: 429 }));
  const small = await model();
  let clock = 1_000_000;
  const router = new Router({
    catalog: catalogOf(['roomy', roomy], ['small', small, { limits: { tpm: 3000 } }]),
    config: { keys: {} },
    now: () => clock,
  });
  router.bench('roomy', 30_000, 'rate limited');
  await assert.rejects(router.dispatch(session(4)), (err) => err instanceof AllProvidersFailed && err.retryAfterMs === 30_000);
  assert.equal(small.requests.length, 0);

  // Out for longer than that: trim for the small one rather than stall.
  router.bench('roomy', 10 * 60_000, 'rate limited');
  const { target, trimmed } = await router.dispatch(session(4));
  assert.equal(target.provider.id, 'small');
  assert.ok(trimmed.toolOutputs > 0);
});

test('a provider that says the conversation is too long gets a trimmed retry', async () => {
  const picky = await model((body) => (estimate(body) > 4000 ? { status: 400, error: "This model's maximum context length is 4096 tokens" } : { content: 'ok' }));
  const router = new Router({ catalog: catalogOf(['picky', picky]), config: { keys: {} } });
  const { target, trimmed, attempts } = await router.dispatch(session(6));
  assert.equal(target.provider.id, 'picky');
  assert.equal(attempts[0].status, 400);
  assert.equal(picky.requests.length, 2);
  assert.ok(trimmed.after < trimmed.before);
});
