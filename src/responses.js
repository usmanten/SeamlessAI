// Translation between OpenAI's Responses API (what Codex speaks) and the
// chat-completions format every provider here understands. Like the
// Anthropic translation, a request comes in as Responses, goes out as chat
// completions, and the answer is turned back, streamed or not.

import { randomBytes } from 'node:crypto';

// Codex's freeform tools (apply_patch, for example) take one string; free
// models only know JSON-schema functions, so the string travels as this one
// argument.
const CUSTOM_ARG = 'input';
// Codex's built-in shell tool on some models: its arguments are the action.
const LOCAL_SHELL = 'local_shell';

/**
 * A Responses API body as a chat-completions body, plus the names of the
 * freeform tools, which the answer needs to send their calls back the way
 * Codex expects.
 */
export function toOpenAI(body) {
  const custom = new Set();
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : body.input || [];

  // Chat completions wants tool calls on an assistant message, followed by
  // one "tool" message per call. Consecutive calls share one assistant message.
  const callMessage = () => {
    const last = messages.at(-1);
    if (last?.role === 'assistant') return last;
    const m = { role: 'assistant', content: null };
    messages.push(m);
    return m;
  };
  const addCall = (id, name, args) => {
    const m = callMessage();
    (m.tool_calls ??= []).push({ id, type: 'function', function: { name, arguments: args } });
  };

  for (const item of input) {
    const type = item.type ?? (item.role ? 'message' : undefined);
    if (type === 'message') {
      const role = item.role === 'developer' || item.role === 'system' ? 'system' : item.role === 'assistant' ? 'assistant' : 'user';
      const content = contentOf(item.content, role);
      if (role === 'assistant') {
        const text = typeof content === 'string' ? content : content.map((p) => p.text ?? '').join('');
        messages.push({ role: 'assistant', content: text || null });
      } else messages.push({ role, content });
    } else if (type === 'function_call') {
      addCall(item.call_id, item.namespace ? `${item.namespace}__${item.name}` : item.name, item.arguments || '{}');
    } else if (type === 'custom_tool_call') {
      addCall(item.call_id, item.name, JSON.stringify({ [CUSTOM_ARG]: item.input ?? '' }));
    } else if (type === 'local_shell_call') {
      addCall(item.call_id ?? item.id, LOCAL_SHELL, JSON.stringify(item.action ?? {}));
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id ?? item.id, content: outputText(item.output) });
    }
    // Reasoning, web searches and compaction markers only mean something to
    // OpenAI's own models, so they are left out.
  }

  const out = { model: body.model, messages: pairToolMessages(messages) };
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  const format = body.text?.format;
  if (format?.type === 'json_schema') out.response_format = { type: 'json_schema', json_schema: { name: format.name || 'answer', schema: format.schema, strict: format.strict } };
  else if (format?.type === 'json_object') out.response_format = { type: 'json_object' };

  const tools = [];
  for (const t of body.tools || []) {
    if (t.type === 'function') tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } } });
    else if (t.type === 'custom') {
      custom.add(t.name);
      const syntax = t.format?.definition ? ` The input must follow this ${t.format.syntax || ''} grammar:\n${t.format.definition}` : '';
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: `${t.description || ''}\nPut the whole raw input in "${CUSTOM_ARG}".${syntax}`.trim(),
          parameters: { type: 'object', properties: { [CUSTOM_ARG]: { type: 'string' } }, required: [CUSTOM_ARG] },
        },
      });
    } else if (t.type === 'local_shell') {
      tools.push({
        type: 'function',
        function: {
          name: LOCAL_SHELL,
          description: 'Run a shell command.',
          parameters: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['exec'] },
              command: { type: 'array', items: { type: 'string' } },
              working_directory: { type: 'string' },
              timeout_ms: { type: 'number' },
            },
            required: ['command'],
          },
        },
      });
    }
    // Hosted tools (web search and the like) run on OpenAI's servers, and
    // namespaced tool groups (Codex's sub-agents) are left out to keep the
    // tool list small for free models.
  }
  if (tools.length) {
    out.tools = tools;
    const choice = body.tool_choice;
    if (choice === 'required' || choice === 'none') out.tool_choice = choice;
    else if (choice?.type === 'function' && choice.name) out.tool_choice = { type: 'function', function: { name: choice.name } };
    if (body.parallel_tool_calls === false) out.parallel_tool_calls = false;
  }
  return { body: out, custom };
}

/** Message content as chat-completions content: a string when it is all text. */
function contentOf(content, role) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = [];
  for (const p of content) {
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') parts.push({ type: 'text', text: p.text });
    else if (p.type === 'refusal') parts.push({ type: 'text', text: p.refusal });
    else if (p.type === 'input_image' && p.image_url) parts.push({ type: 'image_url', image_url: { url: p.image_url } });
    else if (p.type === 'input_image' || p.type === 'input_file') parts.push({ type: 'text', text: '[SeamlessAI: a file was attached here, but it cannot be passed to free models.]' });
  }
  if (role === 'system' || parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n');
  return parts;
}

/** A tool output (a string, or content parts) as text. */
function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((p) => p.text ?? (p.type === 'input_image' ? '[image omitted]' : '')).filter(Boolean).join('\n');
  if (typeof output.content === 'string') return output.content;
  return JSON.stringify(output);
}

/**
 * Makes the tool messages valid for chat completions: every call gets an
 * answer right after its assistant message (an interrupted call gets a
 * note), and an answer with no matching call becomes plain text.
 */
function pairToolMessages(messages) {
  const out = [];
  let open = []; // call ids still waiting for an answer, from the latest assistant message
  const closeOpen = () => {
    for (const id of open) out.push({ role: 'tool', tool_call_id: id, content: '[no output: the call was interrupted]' });
    open = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      if (open.includes(m.tool_call_id)) {
        out.push(m);
        open = open.filter((id) => id !== m.tool_call_id);
      } else out.push({ role: 'user', content: `[Output of an earlier tool call]\n${m.content}` });
      continue;
    }
    closeOpen();
    out.push(m);
    if (m.role === 'assistant' && m.tool_calls) open = m.tool_calls.map((c) => c.id);
  }
  closeOpen();
  return out;
}

/** One tool call from the model as a Responses output item. */
function callItem(call, custom) {
  const callId = call.id || `call_${randomBytes(12).toString('hex')}`;
  const name = call.name || '';
  const args = call.args || '';
  if (custom.has(name)) {
    let input = args;
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed?.[CUSTOM_ARG] === 'string') input = parsed[CUSTOM_ARG];
    } catch {}
    return { type: 'custom_tool_call', id: itemId('ctc'), status: 'completed', call_id: callId, name, input };
  }
  if (name === LOCAL_SHELL) {
    let action = {};
    try {
      action = JSON.parse(args) || {};
    } catch {}
    return { type: 'local_shell_call', id: itemId('lsh'), status: 'completed', call_id: callId, action: { type: 'exec', ...action } };
  }
  const [namespace, inner] = name.includes('__') ? name.split('__', 2) : [];
  const item = { type: 'function_call', id: itemId('fc'), status: 'completed', call_id: callId, name: inner ?? name, arguments: cleanArgs(args) };
  if (namespace) item.namespace = namespace;
  return item;
}

/** Tool arguments as a JSON string. Models sometimes send none, or trailing junk. */
function cleanArgs(args) {
  if (!args) return '{}';
  if (typeof args !== 'string') return JSON.stringify(args);
  try {
    JSON.parse(args);
    return args;
  } catch {
    const end = args.lastIndexOf('}');
    try {
      return JSON.stringify(JSON.parse(args.slice(0, end + 1)));
    } catch {
      return args;
    }
  }
}

function messageItem(text) {
  return { type: 'message', id: itemId('msg'), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
}

function itemId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function responseObject({ id, model, output, usage, finish }) {
  const incomplete = finish === 'length';
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    model,
    output,
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input + usage.output,
    },
  };
}

/** A complete chat completion as a Responses API response. */
export function fromOpenAI(json, { model, custom = new Set() }) {
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  if (message.content) output.push(messageItem(message.content));
  for (const call of message.tool_calls || []) output.push(callItem({ id: call.id, name: call.function?.name, args: call.function?.arguments }, custom));
  const usage = { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 };
  return responseObject({ id: itemId('resp'), model, output, usage, finish: choice.finish_reason });
}

/**
 * A chat-completions answer (a server-sent-event stream, or plain JSON if
 * the provider ignored the stream flag) as a Responses event stream. Text is
 * passed on as it arrives; tool calls are sent whole at the end, since
 * models sometimes send their arguments in pieces out of order.
 */
export function streamToResponses(body, { model, custom = new Set(), isJson = false, inputTokens = 0, onError = () => {} }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const id = itemId('resp');
  let buffer = '';
  let started = false;
  let finished = false;
  let sequence = 0;
  let finish = null;
  let message = null; // the text item being streamed: { id, text, index }
  const output = [];
  const calls = []; // by tool-call index: { id, name, args }
  const usage = { input: inputTokens, output: 0 };
  let events = 0;

  return new ReadableStream({
    async pull(controller) {
      const send = (type, data) => {
        events++;
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`));
      };
      const start = () => {
        if (started) return;
        started = true;
        const response = { ...responseObject({ id, model, output: [], usage, finish: null }), status: 'in_progress' };
        send('response.created', { response });
        send('response.in_progress', { response });
      };
      const text = (t) => {
        if (!t) return;
        start();
        if (!message) {
          message = { id: itemId('msg'), text: '', index: output.length };
          output.push(null); // filled in when the text is done
          send('response.output_item.added', { output_index: message.index, item: { type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] } });
          send('response.content_part.added', { item_id: message.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        message.text += t;
        send('response.output_text.delta', { item_id: message.id, output_index: message.index, content_index: 0, delta: t });
      };
      const closeText = () => {
        if (!message) return;
        const item = { ...messageItem(message.text), id: message.id };
        output[message.index] = item;
        send('response.output_text.done', { item_id: message.id, output_index: message.index, content_index: 0, text: message.text });
        send('response.content_part.done', { item_id: message.id, output_index: message.index, content_index: 0, part: item.content[0] });
        send('response.output_item.done', { output_index: message.index, item });
        message = null;
      };
      const end = () => {
        if (finished) return;
        finished = true;
        start();
        closeText();
        for (const call of calls.filter(Boolean)) {
          const item = callItem(call, custom);
          const index = output.length;
          output.push(item);
          send('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress' } });
          if (item.type === 'function_call') send('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
          send('response.output_item.done', { output_index: index, item });
        }
        const response = responseObject({ id, model, output, usage, finish });
        send(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
        controller.close();
      };
      const take = (chunk) => {
        if (chunk.usage) {
          usage.input = chunk.usage.prompt_tokens ?? usage.input;
          usage.output = chunk.usage.completion_tokens ?? usage.output;
        }
        // An error partway through still comes with HTTP 200, as a chunk.
        if (chunk.error) throw new Error(`${chunk.error.message || 'unknown error'}${chunk.error.code ? ` (${chunk.error.code})` : ''}`);
        const choice = chunk.choices?.[0];
        if (!choice) return;
        const delta = choice.delta ?? choice.message ?? {};
        text(delta.content);
        for (const [i, call] of (delta.tool_calls || []).entries()) {
          const slot = (calls[call.index ?? i] ??= { id: null, name: '', args: '' });
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.args += typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      };

      try {
        if (isJson) {
          let raw = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            raw += decoder.decode(value, { stream: true });
          }
          take(JSON.parse(raw));
          return end();
        }
        // Keep reading until something is sent: a pull that sends nothing is
        // never repeated, which would stall the answer.
        const before = events;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return end();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return end();
            let chunk;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            take(chunk);
            start();
          }
          if (events > before) return;
        }
      } catch (err) {
        if (finished) return;
        finished = true;
        onError(err.message);
        start();
        const response = { ...responseObject({ id, model, output: output.filter(Boolean), usage, finish }), status: 'failed', error: { code: 'server_error', message: `SeamlessAI: the provider's answer broke off: ${err.message}` } };
        send('response.failed', { response });
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
