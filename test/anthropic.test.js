import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Router } from '../src/router.js';
import { createServer } from '../src/server.js';
import { toOpenAI } from '../src/anthropic.js';
import { fakeModel, catalogOf } from './helpers.js';

const open = [];
after(() => open.forEach((c) => c.close()));


/** A provider that streams the given OpenAI chunks as server-sent events. */
async function streamingModel(chunks, { delayMs = 0 } = {}) {
  const state = { requests: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    state.requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify(c)}\n\n`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  open.push({ close: () => (server.closeAllConnections(), server.close()) });
  return state;
}

async function serve(...providers) {
  const router = new Router({ catalog: catalogOf(...providers), config: { keys: {} } });
  const server = createServer(router);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  open.push({ close: () => (server.closeAllConnections(), server.close()) });
  return `http://127.0.0.1:${server.address().port}`;
}

function post(base, path, body) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'anything' }, body: JSON.stringify(body) });
}

function sse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data:')).slice(5)));
}

const TOOLS = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];

test('a plain answer comes back as an Anthropic message', async () => {
  const m = await fakeModel(() => ({ content: 'Hello there' }));
  open.push(m);
  const base = await serve(['groq', m, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.type, 'message');
  assert.equal(json.role, 'assistant');
  assert.deepEqual(json.content, [{ type: 'text', text: 'Hello there' }]);
  assert.equal(json.stop_reason, 'end_turn');
  assert.equal(res.headers.get('x-seamless-provider'), 'groq');
  // Claude's model name means "auto"; the system prompt becomes a system message.
  const sent = m.requests[0].body;
  assert.equal(sent.model, 'groq-model');
  assert.deepEqual(sent.messages[0], { role: 'system', content: 'Be brief.' });
});

test('tool calls and tool results are translated both ways', async () => {
  const m = await fakeModel(() => ({ content: 'Reading it.', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Read', arguments: '{"path":"b.js"}' } }] }));
  open.push(m);
  const base = await serve(['groq', m, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    tools: TOOLS,
    messages: [
      { role: 'user', content: 'read a.js' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'x' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.js' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'const a = 1;' }] }, { type: 'text', text: 'now b.js' }] },
    ],
  });
  const json = await res.json();
  assert.equal(json.stop_reason, 'tool_use');
  assert.deepEqual(json.content, [
    { type: 'text', text: 'Reading it.' },
    { type: 'tool_use', id: 'call_9', name: 'Read', input: { path: 'b.js' } },
  ]);

  const sent = m.requests[0].body;
  assert.deepEqual(sent.tools, [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: TOOLS[0].input_schema } }]);
  assert.deepEqual(sent.messages, [
    { role: 'user', content: 'read a.js' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'const a = 1;' },
    { role: 'user', content: 'now b.js' },
  ]);
});

test('a streamed answer becomes Anthropic events, with tool calls sent whole', async () => {
  const up = await streamingModel([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] },
    { choices: [{ index: 0, delta: { content: 'look.' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"pa' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30 } },
  ]);
  const base = await serve(['kilo', up, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'read a.js' }] });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const events = sse(await res.text());
  assert.deepEqual(
    events.map((e) => e.type),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
  );
  assert.equal(events[2].delta.text + events[3].delta.text, 'Let me look.');
  assert.deepEqual(events[5].content_block, { type: 'tool_use', id: 'call_1', name: 'Read', input: {} });
  assert.equal(events[5].index, 1);
  assert.deepEqual(JSON.parse(events[6].delta.partial_json), { path: 'a.js' });
  assert.equal(events[8].delta.stop_reason, 'tool_use');
  assert.deepEqual(events[8].usage, { input_tokens: 1200, output_tokens: 30 });
  assert.equal(up.requests[0].stream, true);
  assert.deepEqual(up.requests[0].stream_options, { include_usage: true });
});

test('tool arguments sent twice keep the first complete copy', async () => {
  const args = '{"file_path":"a.html","content":"<style>p{color:red}</style>"}';
  const up = await streamingModel([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'Write', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: 'tool_calls' }] },
  ]);
  const base = await serve(['kilo', up, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'write a.html' }] });
  const call = sse(await res.text()).find((e) => e.delta?.type === 'input_json_delta');
  assert.deepEqual(JSON.parse(call.delta.partial_json), { file_path: 'a.html', content: '<style>p{color:red}</style>' });
});

test('a stream keeps going through chunks that carry nothing to send (reasoning, partial tool calls)', async () => {
  const up = await streamingModel(
    [
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Thinking' } }] },
      { choices: [{ index: 0, delta: { reasoning_content: ' more' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.js"}' } }] } }] },
      { choices: [{ index: 0, delta: { reasoning_content: ' done' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ],
    { delayMs: 20 },
  );
  const base = await serve(['kilo', up, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 100, stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'read a.js' }] });
  const events = sse(await res.text());
  assert.equal(events.at(-1).type, 'message_stop');
  assert.deepEqual(JSON.parse(events.find((e) => e.delta?.type === 'input_json_delta').delta.partial_json), { path: 'a.js' });
});

test('a provider that ignores the stream flag still gives a streamed answer', async () => {
  const m = await fakeModel(() => ({ content: 'plain' }));
  open.push(m);
  const base = await serve(['groq', m, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', { model: 'claude-haiku-4-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const events = sse(await res.text());
  assert.equal(events.find((e) => e.type === 'content_block_delta').delta.text, 'plain');
  assert.equal(events.at(-1).type, 'message_stop');
});

test('Claude Code requests with tools skip models not shown to handle tools', async () => {
  const unknown = await fakeModel(() => ({ content: 'from unknown' }));
  const proven = await fakeModel(() => ({ content: 'from proven' }));
  open.push(unknown, proven);
  const base = await serve(['first', unknown, {}, {}], ['second', proven, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 10, tools: TOOLS, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await res.json()).content[0].text, 'from proven');
  assert.equal(unknown.requests.length, 0);
  // Without tools, any model will do.
  const plain = await post(base, '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await plain.json()).content[0].text, 'from unknown');
});

test('when every provider fails the error is in Anthropic format', async () => {
  const m = await fakeModel(() => ({ status: 429, error: 'slow down' }));
  open.push(m);
  const base = await serve(['groq', m, {}, { tools: true }]);
  const res = await post(base, '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.equal(json.type, 'error');
  assert.equal(json.error.type, 'rate_limit_error');
  assert.match(json.error.message, /slow down/);
});

test('count_tokens gives an estimate', async () => {
  const base = await serve();
  const res = await post(base, '/v1/messages/count_tokens', { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x'.repeat(3000) }] });
  const { input_tokens } = await res.json();
  assert.ok(input_tokens >= 1000 && input_tokens < 1100, String(input_tokens));
});

test('images, documents, errors and tool choice are translated', () => {
  const out = toOpenAI({
    model: 'm',
    max_tokens: 5,
    tools: [...TOOLS, { type: 'web_search_20250305', name: 'web_search' }],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    stop_sequences: ['END'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't', is_error: true, content: 'no such file' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'document', source: {} },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ],
  });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tool_choice, 'required');
  assert.equal(out.parallel_tool_calls, false);
  assert.deepEqual(out.stop, ['END']);
  assert.deepEqual(out.messages[0], { role: 'tool', tool_call_id: 't', content: 'Error: no such file' });
  assert.equal(out.messages[1].content[0].image_url.url, 'data:image/png;base64,AAA');
  assert.match(out.messages[1].content[1].text, /document/);
  assert.equal(out.messages[1].content[2].text, 'what is this?');
});
