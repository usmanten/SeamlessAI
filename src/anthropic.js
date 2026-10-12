// Translation between Anthropic's Messages API (what Claude Code speaks) and
// the OpenAI chat-completions format every provider here understands. A
// request comes in as Anthropic, goes out as OpenAI, and the answer is turned
// back into Anthropic, streamed or not.

import { randomBytes } from 'node:crypto';

const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };

/** An Anthropic /v1/messages body as an OpenAI chat-completions body. */
export function toOpenAI(body) {
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages) {
    if (m.role === 'assistant') messages.push(assistantMessage(m.content));
    else messages.push(...userMessages(m.content));
  }

  const out = { model: body.model, messages, max_tokens: body.max_tokens };
  if (body.stream) {
    out.stream = true;
    // Claude Code reads the token counts to know when to compact.
    out.stream_options = { include_usage: true };
  }
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;

  // Server-side tools (Anthropic's own web search and the like) only exist
  // on Anthropic's servers, so only client tools are passed on.
  const tools = (body.tools || []).filter((t) => t.input_schema);
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const choice = body.tool_choice;
    if (choice?.type === 'any') out.tool_choice = 'required';
    else if (choice?.type === 'tool') out.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice?.type === 'none') out.tool_choice = 'none';
    if (choice?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  return out;
}

function assistantMessage(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const calls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  // Thinking blocks are left out: other models can't use another's signed reasoning.
  const message = { role: 'assistant', content: text || null };
  if (calls.length) message.tool_calls = calls;
  return message;
}

/**
 * One Anthropic user turn as OpenAI messages: each tool result becomes its
 * own "tool" message (these must come straight after the assistant's tool
 * calls), then anything else the user sent.
 */
function userMessages(content) {
  if (typeof content === 'string') return [{ role: 'user', content }];
  const out = [];
  const parts = [];
  for (const b of content) {
    if (b.type === 'tool_result') {
      const text = textOf(b.content, { images: true });
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${text}` : text });
    } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: imageUrl(b.source) } });
    else if (b.type === 'document') parts.push({ type: 'text', text: '[SeamlessAI: a document was attached here, but it cannot be passed to free models.]' });
  }
  if (parts.length) {
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
  }
  return out;
}

function imageUrl(source = {}) {
  return source.type === 'url' ? source.url : `data:${source.media_type};base64,${source.data}`;
}

/** Text of a string or a list of content blocks. Images become a note (tool results can't carry them). */
function textOf(content, { images = false } = {}) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? b.text : images && b.type === 'image' ? '[image omitted: SeamlessAI cannot pass images inside tool results]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** A complete OpenAI chat completion as an Anthropic message. */
export function fromOpenAI(json, model) {
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls || []) content.push(toolUse(call.id, call.function?.name, call.function?.arguments));
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(choice.finish_reason, content),
    stop_sequence: null,
    usage: { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 },
  };
}

function toolUse(id, name, args) {
  return { type: 'tool_use', id: id || `toolu_${randomBytes(12).toString('hex')}`, name, input: parseArgs(args) };
}

/** The first balanced {...} in text, skipping braces inside strings. */
function firstObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Tool arguments as an object (or `broken` if they don't parse). Models sometimes send none, or slightly broken JSON. */
function parseArgs(args, broken = {}) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : broken;
  } catch {
    // Text after the JSON object (a stray token, or the whole object sent
    // twice) is the common case, so keep the first complete object.
    const first = firstObject(args);
    try {
      return first ? JSON.parse(first) : broken;
    } catch {
      return broken;
    }
  }
}

function stopReason(finish, content) {
  // Some providers say "stop" even when the answer is a tool call.
  if (content.some((b) => b.type === 'tool_use')) return 'tool_use';
  return STOP_REASONS[finish] ?? 'end_turn';
}

function messageId() {
  return `msg_${randomBytes(12).toString('hex')}`;
}

/**
 * An OpenAI answer (a server-sent-event stream, or plain JSON if the
 * provider ignored the stream flag) as an Anthropic event stream. Text is
 * passed on as it arrives; tool calls are collected and sent whole at the
 * end, since Claude Code only acts on complete ones and models sometimes
 * send their arguments out of order.
 */
export function streamToAnthropic(body, { model, isJson = false, inputTokens = 0, onError = () => {} }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let started = false;
  let finished = false;
  let index = 0; // next content block index
  let textOpen = false;
  let finish = null;
  const calls = []; // by OpenAI tool-call index: { id, name, args }
  const usage = { input_tokens: inputTokens, output_tokens: 0 };
  let events = 0; // sent so far

  return new ReadableStream({
    async pull(controller) {
      const send = (type, data) => {
        events++;
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
      };
      const start = () => {
        if (started) return;
        started = true;
        send('message_start', { message: { id: messageId(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage } } });
      };
      const text = (t) => {
        if (!t) return;
        start();
        if (!textOpen) {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
          textOpen = true;
        }
        send('content_block_delta', { index, delta: { type: 'text_delta', text: t } });
      };
      const closeText = () => {
        if (!textOpen) return;
        send('content_block_stop', { index });
        textOpen = false;
        index++;
      };
      const end = () => {
        if (finished) return;
        finished = true;
        start();
        closeText();
        // A call cut off partway (the model ran out of room, or its arguments
        // don't parse) would reach the tool with nothing in it, so it's left
        // out and the answer reports running out of room instead.
        const usable = calls.filter((call) => call && finish !== 'length' && parseArgs(call.args, null) !== null);
        for (const call of usable) {
          const block = toolUse(call.id, call.name, call.args);
          send('content_block_start', { index, content_block: { ...block, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
          send('content_block_stop', { index });
          index++;
        }
        const reason = usable.length ? 'tool_use' : calls.some(Boolean) ? 'max_tokens' : STOP_REASONS[finish] ?? 'end_turn';
        send('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage });
        send('message_stop', {});
        controller.close();
      };
      const take = (chunk) => {
        if (chunk.usage) {
          usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
          usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
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
        // Read until at least one event has been sent (or the stream ends):
        // a pull that sends nothing is never repeated, which would stall the
        // answer. Reasoning-only chunks, for example, send nothing.
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
        send('error', { error: { type: 'api_error', message: `SeamlessAI: the provider's answer broke off: ${err.message}` } });
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The Anthropic error type for an HTTP status. */
export function errorType(status) {
  if (status === 400 || status === 413) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}
