import http from 'node:http';

// A fake OpenAI-compatible provider whose answers come from `answer(body)`,
// which a test can swap between requests. `answer` returns a chat message,
// or { status, error } to fail.
export async function fakeModel(answer) {
  const state = { answer, requests: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push({ body, auth: req.headers.authorization });
    const out = state.answer(body);
    if (out.status) {
      res.writeHead(out.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: out.error || `fake ${out.status}` } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', ...out } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return state;
}

/** Answers every test in the suite correctly. */
export function smartAnswer(body) {
  const last = body.messages.at(-1);
  const first = String(body.messages[0].content);
  if (first.includes('(3 + 4) * 5')) {
    const toolResults = body.messages.filter((m) => m.role === 'tool');
    if (toolResults.length === 0) return call('add', { a: 3, b: 4 });
    if (toolResults.length === 1) return call('multiply', { a: Number(toolResults[0].content), b: 5 });
    return { content: toolResults[1].content };
  }
  if (last.content.includes('PONG')) return { content: 'PONG' };
  if (last.content.includes('weather')) return call('get_weather', { city: 'Paris' });
  if (last.content.includes('sumOfEvens')) return { content: '```js\nif (n % 2 === 0) total += n;\n```' };
  if (last.content.includes('deploy code')) return { content: 'ORCHID-4417' };
  return { content: 'ok' };
}

function call(name, args) {
  return { content: null, reasoning_content: 'thinking', tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

export function catalogOf(...providers) {
  return {
    providers: providers.map(([id, upstream, extra = {}, model = {}]) => ({
      id,
      name: id,
      baseUrl: upstream.url,
      auth: { required: false },
      models: [{ id: `${id}-model`, ...model }],
      ...extra,
    })),
  };
}

export function chat(extra = {}) {
  return { model: 'auto', messages: [{ role: 'user', content: 'hello' }], ...extra };
}
