import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/router.js';
import { createServer } from '../src/server.js';
import { toOpenAI } from '../src/responses.js';
import { fakeModel, streamingModel, catalogOf } from './helpers.js';

const open = [];
after(() => open.forEach((c) => c.close()));

async function serve(...providers) {
  const router = new Router({ catalog: catalogOf(...providers), config: { keys: {} } });
  const server = createServer(router);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  open.push({ close: () => (server.closeAllConnections(), server.close()) });
  return `http://127.0.0.1:${server.address().port}`;
}

function post(base, body) {
  return fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function events(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data:')).slice(5)));
}

// What Codex sends, cut down: developer instructions as messages, a shell
// tool, a freeform patch tool, and tools free models can't use.
const TOOLS = [
  { type: 'function', name: 'exec_command', description: 'Run a command', strict: false, parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'custom', name: 'apply_patch', description: 'Edit files', format: { type: 'grammar', syntax: 'lark', definition: 'start: patch' } },
  { type: 'namespace', name: 'multi_agent_v1', tools: [] },
  { type: 'web_search', external_web_access: false },
];

function codexInput(...rest) {
  return [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] },
    ...rest,
  ];
}

test('a Codex request becomes a chat request with tool calls paired to their output', () => {
  const { body, custom } = toOpenAI({
    model: 'auto',
    stream: true,
    tools: TOOLS,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { summary: 'auto' },
    input: codexInput(
      { type: 'reasoning', summary: [], encrypted_content: 'xyz' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
      { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a.js' },
      { type: 'custom_tool_call', call_id: 'c3', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'c3', output: [{ type: 'input_text', text: 'Done' }] },
    ),
  });
  assert.deepEqual(custom, new Set(['apply_patch']));
  assert.deepEqual(
    body.tools.map((t) => t.function.name),
    ['exec_command', 'apply_patch'],
  );
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are Codex.' },
    { role: 'user', content: 'list the files' },
    {
      role: 'assistant',
      content: 'Looking.',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } },
        { id: 'c2', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'a.js' },
    // c2 never got an answer (interrupted), which chat completions refuses.
    { role: 'tool', tool_call_id: 'c2', content: '[no output: the call was interrupted]' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: 'Done' },
  ]);
});

test('a plain answer comes back as a Responses object', async () => {
  const m = await fakeModel(() => ({ content: 'Two files.' }));
  open.push(m);
  const base = await serve(['nvidia', m, {}, { tools: true }]);
  const res = await post(base, { model: 'gpt-5.5', input: 'how many files?', instructions: 'Be brief.' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.object, 'response');
  assert.equal(json.status, 'completed');
  assert.deepEqual(json.output[0].content, [{ type: 'output_text', text: 'Two files.', annotations: [] }]);
  assert.equal(res.headers.get('x-seamless-provider'), 'nvidia');
  // OpenAI's model names mean "auto".
  assert.equal(m.requests[0].body.model, 'nvidia-model');
  assert.deepEqual(m.requests[0].body.messages[0], { role: 'system', content: 'Be brief.' });
});

test('a streamed answer with text and tool calls becomes Responses events', async () => {
  const m = await streamingModel([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] },
    { choices: [{ index: 0, delta: { content: 'look.' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } },
  ]);
  open.push(m);
  const base = await serve(['nvidia', m, {}, { tools: true }]);
  const res = await post(base, { model: 'auto', stream: true, tools: TOOLS, input: codexInput() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const evs = events(await res.text());
  assert.deepEqual(
    evs.map((e) => e.type),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ],
  );
  const done = evs.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  assert.equal(done[0].content[0].text, 'Let me look.');
  assert.deepEqual({ type: done[1].type, call_id: done[1].call_id, name: done[1].name, arguments: done[1].arguments }, { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' });
  // The freeform tool's call goes back as Codex sent the tool: raw input, not JSON.
  assert.deepEqual({ type: done[2].type, name: done[2].name, input: done[2].input }, { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n' });
  const completed = evs.at(-1).response;
  assert.equal(completed.output.length, 3);
  assert.deepEqual([completed.usage.input_tokens, completed.usage.output_tokens], [50, 9]);
  assert.deepEqual(evs.map((e) => e.sequence_number), evs.map((_, i) => i));
});

test('an error partway through a stream fails the response instead of completing it', async () => {
  const m = await streamingModel([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] },
    { choices: [], error: { code: 504, message: 'Upstream idle timeout exceeded' } },
  ]);
  open.push(m);
  const base = await serve(['nvidia', m, {}, { tools: true }]);
  const res = await post(base, { model: 'auto', stream: true, tools: TOOLS, input: codexInput() });
  const last = events(await res.text()).at(-1);
  assert.equal(last.type, 'response.failed');
  assert.match(last.response.error.message, /Upstream idle timeout exceeded \(504\)/);
  assert.equal(last.response.output.length, 0);
});

test('Codex requests only go to models known to handle tools', async () => {
  const unproven = await fakeModel(() => ({ content: 'from unproven' }));
  const proven = await fakeModel(() => ({ content: 'from proven' }));
  open.push(unproven, proven);
  const base = await serve(['groq', unproven], ['nvidia', proven, {}, { tools: true }]);
  const res = await post(base, { model: 'auto', tools: TOOLS, input: codexInput() });
  const json = await res.json();
  assert.equal(json.output[0].content[0].text, 'from proven');
  assert.equal(unproven.requests.length, 0);
});

test('when every provider fails, Codex gets an OpenAI-style 429', async () => {
  const m = await fakeModel(() => ({ status: 429, error: 'slow down' }));
  open.push(m);
  const base = await serve(['nvidia', m, {}, { tools: true }]);
  const res = await post(base, { model: 'auto', input: 'hi' });
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.equal(json.error.type, 'all_providers_exhausted');
});
