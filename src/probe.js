import { errorIn, readSnippet, requestNeeds } from './router.js';

// The model test suite behind `seamless test`. Each test sends a fixed,
// made-up prompt (never the user's code) and checks the answer with plain
// string and JSON checks. Model output is never executed.

const MAX_WAIT_MS = 65_000; // wait out a per-minute limit, but not longer
const TOOL_ROUNDS = 6;
const MIN_RAN = 3; // fewer tests than this actually run: not enough to score

class Skip extends Error {}

class Failed extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const WEATHER_TOOL = tool('get_weather', 'Get the current weather for a city.', { city: { type: 'string', description: 'City name' } });
const MATH_TOOLS = [
  tool('add', 'Add two numbers.', { a: { type: 'number' }, b: { type: 'number' } }),
  tool('multiply', 'Multiply two numbers.', { a: { type: 'number' }, b: { type: 'number' } }),
];

const BUGGY_FUNCTION = `function sumOfEvens(numbers) {
  let total = 0;
  for (const n of numbers) {
    if (n % 2 === 1) total += n;
  }
  return total;
}`;

export const TESTS = [
  {
    id: 'basic',
    about: 'follows a simple instruction',
    async run(ask) {
      const { message } = await ask({ messages: [user('Reply with exactly the word PONG and nothing else.')] });
      const word = String(message.content ?? '').replace(/[^a-z]/gi, '').toUpperCase();
      return word === 'PONG' ? pass() : fail(`answered ${quote(message.content)}`);
    },
  },
  {
    id: 'tool-call',
    about: 'calls a tool with valid arguments',
    async run(ask) {
      const { message } = await ask({
        messages: [user('What is the weather in Paris right now? Use the get_weather tool.')],
        tools: [WEATHER_TOOL],
      });
      const call = message.tool_calls?.[0];
      if (!call) return fail(`no tool call, answered ${quote(message.content)}`);
      if (call.function?.name !== 'get_weather') return fail(`called ${quote(call.function?.name)}`);
      const args = parseArgs(call.function.arguments);
      return /paris/i.test(String(args?.city ?? '')) ? pass() : fail(`bad arguments ${quote(call.function.arguments)}`);
    },
  },
  {
    id: 'tool-loop',
    about: 'uses tool results over several rounds',
    async run(ask) {
      const messages = [user('Use the tools to compute (3 + 4) * 5. Call one tool at a time. When you are done, reply with just the final number.')];
      let calls = 0;
      for (let round = 0; round < TOOL_ROUNDS; round++) {
        const { message } = await ask({ messages, tools: MATH_TOOLS });
        if (!message.tool_calls?.length) {
          if (calls < 2) return fail(`answered after ${calls} tool call(s): ${quote(message.content)}`);
          return /\b35\b/.test(String(message.content ?? '')) ? pass() : fail(`final answer ${quote(message.content)}`);
        }
        // Send the assistant turn back whole: reasoning models (e.g. Kimi) need
        // their own reasoning fields to continue a tool loop.
        messages.push({ ...message, role: 'assistant', content: message.content ?? null });
        for (const call of message.tool_calls) {
          calls++;
          messages.push({ role: 'tool', tool_call_id: call.id, content: runMathTool(call.function) });
        }
      }
      return fail(`still calling tools after ${TOOL_ROUNDS} rounds`);
    },
  },
  {
    id: 'code-fix',
    about: 'finds and fixes a bug',
    async run(ask) {
      const { message } = await ask({
        messages: [user(`This JavaScript function should return the sum of the even numbers, but it has a bug.\n\n${BUGGY_FUNCTION}\n\nReply with only the corrected line of code, nothing else.`)],
      });
      const text = String(message.content ?? '');
      const fixed = /n\s*%\s*2\s*={2,3}\s*0|n\s*%\s*2\s*!==?\s*1|!\s*\(\s*n\s*%\s*2\s*\)|n\s*&\s*1\s*\)?\s*={2,3}\s*0/.test(text);
      return fixed ? pass() : fail(`answered ${quote(text)}`);
    },
  },
  {
    id: 'long-input',
    about: 'finds one detail in a long log (~4K tokens)',
    async run(ask, target) {
      const log = longLog();
      const body = { messages: [user(`${log}\n\nWhat is the deploy code mentioned in the log above? Reply with just the code.`)] };
      const needed = requestNeeds(body).tokens;
      if (target.model.context && needed > target.model.context) throw new Skip('context too small');
      const { message } = await ask(body);
      return String(message.content ?? '').includes('ORCHID-4417') ? pass() : fail(`answered ${quote(message.content)}`);
    },
  },
];

/**
 * Runs every test against one target. Resolves with a result that can be
 * saved with saveProbes(); never throws for a failing model.
 */
export async function probeTarget(router, target, { only, sleep = defaultSleep } = {}) {
  const results = [];
  let unreachable = null;
  for (const test of TESTS) {
    if (only && !only.includes(test.id)) continue;
    if (unreachable) {
      results.push({ test: test.id, status: 'skipped', detail: unreachable });
      continue;
    }
    const started = router.now();
    try {
      const outcome = await test.run((body) => ask(router, target, body, sleep), target);
      results.push({ test: test.id, status: outcome.ok ? 'pass' : 'fail', ms: router.now() - started, detail: outcome.detail });
    } catch (err) {
      if (err instanceof Skip) {
        results.push({ test: test.id, status: 'skipped', detail: err.message });
        continue;
      }
      results.push({ test: test.id, status: 'fail', ms: router.now() - started, detail: err.message });
      // A missing model or rejected key will fail every test the same way;
      // don't spend quota proving it.
      if ([401, 403, 404].includes(err.status)) unreachable = `model unreachable (${err.status})`;
      // Two timeouts in a row: the model is down or far too slow to be useful.
      if (err.message === 'timed out' && results.at(-2)?.detail === 'timed out') unreachable = 'model keeps timing out';
    }
  }

  const ran = results.filter((r) => r.status !== 'skipped');
  const passed = ran.filter((r) => r.status === 'pass');
  const times = passed.map((r) => r.ms);
  return {
    id: target.id,
    // Too few tests ran (rate limits, skips) for a fair score: leave it unset
    // so ranking falls back to the catalog tier.
    // A model we know is missing or down scores 0.
    score: unreachable ? 0 : ran.length >= MIN_RAN ? Math.round((100 * passed.length) / ran.length) : null,
    passed: passed.length,
    ran: ran.length,
    avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    testedAt: new Date(router.now()).toISOString(),
    results,
  };
}

/** One non-streaming request to exactly this target, respecting its limits. */
async function ask(router, target, body, sleep) {
  const request = { ...body, stream: false };
  const need = requestNeeds(request);
  const unfit = router.unfitFor(target, need);
  if (unfit) throw new Skip(unfit);
  let blocked = router.blockedFor(target, need);
  if (blocked && blocked.ms <= MAX_WAIT_MS) {
    await sleep(blocked.ms + 250);
    blocked = router.blockedFor(target, need);
  }
  if (blocked) throw new Skip(blocked.reason);

  router.recordUse(target, need.tokens);
  let res;
  try {
    res = await router.send(target, request);
  } catch (err) {
    throw new Failed(err.name === 'TimeoutError' ? 'timed out' : `network error: ${err.message}`);
  }
  if (!res.ok) {
    if (res.status === 429) throw new Skip('rate limited');
    // Too big for a limit (e.g. Groq's input tokens per minute): a capacity
    // limit, not a wrong answer.
    if (res.status === 413) throw new Skip(`too large for its limits: ${await readSnippet(res)}`.slice(0, 160));
    throw new Failed(`${res.status} ${await readSnippet(res)}`.trim(), res.status);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Failed('response was not JSON');
  }
  const hidden = errorIn(json);
  if (hidden) throw new Failed(`${hidden.status} ${hidden.error}`, hidden.status);
  const message = json.choices[0]?.message;
  if (!message) throw new Failed('response had no message');
  return { message, usage: json.usage };
}

/** The math tools, evaluated on plain numbers only. */
function runMathTool(fn) {
  const args = parseArgs(fn?.arguments);
  const a = Number(args?.a);
  const b = Number(args?.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'error: a and b must be numbers';
  if (fn.name === 'add') return String(a + b);
  if (fn.name === 'multiply') return String(a * b);
  return `error: unknown tool ${String(fn?.name).slice(0, 40)}`;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function longLog() {
  const lines = [];
  for (let i = 1; i <= 300; i++) {
    lines.push(i === 213 ? `line ${i}: deploy code is ORCHID-4417` : `line ${i}: request handled in ${(i * 37) % 500} ms, status ok`);
  }
  return lines.join('\n');
}

function tool(name, description, properties) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties) } } };
}

function user(content) {
  return { role: 'user', content };
}

function pass() {
  return { ok: true };
}

function fail(detail) {
  return { ok: false, detail };
}

function quote(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return `"${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
