import http from 'node:http';
import { Readable } from 'node:stream';
import { AllProvidersFailed, requestNeeds } from './router.js';
import { toOpenAI, fromOpenAI, streamToAnthropic, errorType } from './anthropic.js';
import * as responsesApi from './responses.js';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * A local OpenAI-compatible server. Point any tool that accepts a custom
 * base URL at http://127.0.0.1:<port>/v1 and use model "auto". It also
 * speaks Anthropic's Messages API (/v1/messages) for Claude Code and
 * OpenAI's Responses API (/v1/responses) for Codex.
 */
export function createServer(router, { log = () => {}, localOnly = true } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '');
    // Web pages the user visits can send requests to localhost too. Refuse
    // them (and DNS-rebinding tricks) so no website can spend the user's
    // free quota or read answers through their keys.
    const refusal = refuseBrowserOrigin(req, localOnly);
    if (refusal) {
      log(`! refused request: ${refusal}`);
      return sendError(res, 403, refusal, 'forbidden');
    }
    try {
      if (req.method === 'GET' && (route === '' || route === '/health')) {
        return sendJson(res, 200, { ok: true, providers: router.status() });
      }
      if (req.method === 'GET' && route === '/v1/models') {
        return sendJson(res, 200, listModels(router));
      }
      if (req.method === 'POST' && route === '/v1/chat/completions') {
        return await chatCompletions(router, req, res, log);
      }
      if (req.method === 'POST' && route === '/v1/messages') {
        return await messages(router, req, res, log);
      }
      if (req.method === 'POST' && route === '/v1/responses') {
        return await responses(router, req, res, log);
      }
      if (req.method === 'POST' && route === '/v1/messages/count_tokens') {
        return await countTokens(req, res);
      }
      sendError(res, 404, `No route for ${req.method} ${url.pathname}`, 'not_found');
    } catch (err) {
      log(`! ${err.stack || err.message}`);
      if (!res.headersSent) sendError(res, 500, err.message, 'internal_error');
      else res.destroy(err);
    }
  });
}

async function chatCompletions(router, req, res, log) {
  const body = await readJson(req, res, sendError);
  if (!body) return;
  if (!Array.isArray(body.messages)) {
    return sendError(res, 400, '"messages" must be an array', 'invalid_request_error');
  }
  log(`→ chat ${body.model || 'auto'}${body.stream ? ' (stream)' : ''}`);
  const result = await routeRequest(router, body, res, { log, fail: sendError });
  if (!result) return;
  res.writeHead(result.response.status, result.headers);
  pipe(result.answer, res, result.target, log);
}

/**
 * Anthropic's Messages API, which Claude Code uses: translated to the OpenAI
 * format, routed like any other request, and the answer translated back.
 */
async function messages(router, req, res, log) {
  const body = await readJson(req, res, sendAnthropicError);
  if (!body) return;
  if (!Array.isArray(body.messages)) {
    return sendAnthropicError(res, 400, '"messages" must be an array');
  }
  const openai = toOpenAI(body);
  log(`→ messages ${body.model || 'auto'}${body.stream ? ' (stream)' : ''}`);
  // Claude Code names its own models ("claude-sonnet-..."); those mean "auto".
  if (/^claude-/i.test(openai.model || '')) openai.model = 'auto';
  // Claude Code works through tools, so a model that fumbles them breaks
  // the task halfway: only models known to handle tools are used.
  const result = await routeRequest(router, openai, res, { log, fail: sendAnthropicError, provenTools: true });
  if (!result) return;
  const { response, target, headers } = result;
  const isJson = !(response.headers.get('content-type') || '').includes('text/event-stream');
  const model = body.model || target.id;
  if (!body.stream) {
    let json;
    try {
      json = JSON.parse(await new Response(result.answer).text());
    } catch {
      return sendAnthropicError(res, 502, `${target.id} sent an answer that is not JSON`);
    }
    const { 'content-type': _, ...seamlessHeaders } = headers;
    return sendJson(res, 200, fromOpenAI(json, model), seamlessHeaders);
  }
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
  const inputTokens = requestNeeds({ ...openai, max_tokens: 0 }).tokens;
  pipe(streamToAnthropic(result.answer, { model, isJson, inputTokens }), res, target, log);
}

/**
 * OpenAI's Responses API, which Codex uses: translated to chat completions,
 * routed like any other request, and the answer translated back.
 */
async function responses(router, req, res, log) {
  const body = await readJson(req, res, sendError);
  if (!body) return;
  if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) {
    return sendError(res, 400, '"input" must be a string or an array', 'invalid_request_error');
  }
  const { body: openai, custom } = responsesApi.toOpenAI(body);
  log(`→ responses ${body.model || 'auto'}${body.stream ? ' (stream)' : ''}`);
  // OpenAI's own model names (Codex's default) mean "auto".
  if (!openai.model || /^(gpt-|o\d|codex)/i.test(openai.model)) openai.model = 'auto';
  // Codex works through tools, so only models known to handle them are used.
  const result = await routeRequest(router, openai, res, { log, fail: sendError, provenTools: true });
  if (!result) return;
  const { response, target, headers } = result;
  const isJson = !(response.headers.get('content-type') || '').includes('text/event-stream');
  const model = body.model || target.id;
  if (!body.stream) {
    let json;
    try {
      json = JSON.parse(await new Response(result.answer).text());
    } catch {
      return sendError(res, 502, `${target.id} sent an answer that is not JSON`, 'upstream_error');
    }
    const { 'content-type': _, ...seamlessHeaders } = headers;
    return sendJson(res, 200, responsesApi.fromOpenAI(json, { model, custom }), seamlessHeaders);
  }
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
  const inputTokens = requestNeeds({ ...openai, max_tokens: 0 }).tokens;
  pipe(responsesApi.streamToResponses(result.answer, { model, custom, isJson, inputTokens }), res, target, log);
}

/** An estimate of a Messages request's input tokens (Claude Code asks before big requests). */
async function countTokens(req, res) {
  const body = await readJson(req, res, sendAnthropicError);
  if (!body) return;
  if (!Array.isArray(body.messages)) return sendAnthropicError(res, 400, '"messages" must be an array');
  sendJson(res, 200, { input_tokens: requestNeeds({ ...toOpenAI(body), max_tokens: 0 }).tokens });
}

/**
 * Sends an OpenAI-format body through the router. Resolves with the answer
 * to send back, or null once an error has been sent with `fail`.
 */
async function routeRequest(router, body, res, { log, fail, provenTools = false }) {
  // Stop upstream work if the client hangs up.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  let result;
  try {
    result = await router.dispatch(body, { signal: abort.signal, provenTools });
  } catch (err) {
    if (abort.signal.aborted) return null;
    if (!(err instanceof AllProvidersFailed)) throw err;
    const headers = err.retryAfterMs ? { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } : {};
    const tried = err.attempts.map((a) => (a.skipped ? `${a.target}: skipped (${a.skipped})` : `${a.target}: ${a.status ?? ''} ${a.error ?? ''}`.trim()));
    const message = err.attempts.length
      ? `All providers failed or are rate limited. ${tried.join('; ')}`
      : 'No providers are usable. Add a key with `seamless keys set <provider> <key>` or check `seamless providers`.';
    fail(res, 429, message, 'all_providers_exhausted', headers);
    return null;
  }

  const { response, target, trimmed } = result;
  const headers = {
    'content-type': response.headers.get('content-type') || 'application/json',
    'cache-control': 'no-cache',
    'x-seamless-provider': target.provider.id,
    'x-seamless-model': target.model.id,
  };
  // The conversation didn't fit any model whole: say what was cut (the
  // router has already logged it), in a header and, so the user sees it in
  // their tool, at the start of the answer.
  let answer = response.body;
  if (trimmed) {
    headers['x-seamless-trimmed'] = trimmed.summary;
    if (answer && !wantsJson(body)) {
      const notice = `[SeamlessAI trimmed this conversation to fit ${target.id}: ${trimmed.summary}.]\n\n`;
      const streamed = (response.headers.get('content-type') || '').includes('text/event-stream');
      answer = streamed ? streamWithNotice(answer, notice) : await jsonWithNotice(response, notice);
    }
  }
  return { response, target, headers, answer: answer ?? new Response('').body };
}

function pipe(stream, res, target, log) {
  Readable.fromWeb(stream)
    .on('error', (err) => {
      log(`! stream from ${target.id} broke: ${err.message}`);
      res.destroy(err);
    })
    .pipe(res);
}

async function readJson(req, res, fail) {
  try {
    return JSON.parse(await readBody(req));
  } catch (err) {
    fail(res, 400, `Invalid JSON body: ${err.message}`, 'invalid_request_error');
    return null;
  }
}

/** Whether the client asked for a JSON-only answer, which a notice would break. */
function wantsJson(body) {
  const type = body.response_format?.type;
  return type === 'json_object' || type === 'json_schema';
}

/** A non-streamed answer with the notice put before the first choice's text. */
async function jsonWithNotice(response, notice) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const message = json.choices?.[0]?.message;
    if (message && (typeof message.content === 'string' || message.content == null)) {
      message.content = notice + (message.content ?? '');
      return new Response(JSON.stringify(json)).body;
    }
  } catch {}
  return new Response(text).body;
}

/**
 * A streamed answer with one extra event carrying the notice, sent before
 * the upstream's first event and labelled with that event's id and model so
 * clients take it as part of the same answer.
 */
function streamWithNotice(stream, notice) {
  const reader = stream.getReader();
  let first = true;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      if (first) {
        first = false;
        const line = new TextDecoder().decode(value).split('\n').find((l) => l.startsWith('data:'));
        let base = {};
        try {
          base = JSON.parse(line.slice(5));
        } catch {}
        const event = { id: base.id, object: 'chat.completion.chunk', created: base.created, model: base.model, choices: [{ index: 0, delta: { role: 'assistant', content: notice }, finish_reason: null }] };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function refuseBrowserOrigin(req, localOnly) {
  const origin = req.headers.origin;
  if (origin !== undefined && !isLocalHost(origin)) return `requests from web pages (${String(origin).slice(0, 100)}) are not allowed`;
  if (localOnly && !isLocalHost(`http://${req.headers.host || ''}`)) return 'unexpected Host header';
  return null;
}

function isLocalHost(urlLike) {
  try {
    return LOCAL_HOSTS.has(new URL(urlLike).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

export function isLoopback(host) {
  return LOCAL_HOSTS.has(String(host).replace(/^\[|\]$/g, ''));
}

function listModels(router) {
  const created = Math.floor(Date.now() / 1000);
  const data = [{ id: 'auto', object: 'model', created, owned_by: 'seamless' }];
  for (const t of router.targets()) data.push({ id: t.id, object: 'model', created, owned_by: t.provider.id });
  return { object: 'list', data };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message, type, headers) {
  sendJson(res, status, { error: { message, type, code: type } }, headers);
}

function sendAnthropicError(res, status, message, _type, headers) {
  sendJson(res, status, { type: 'error', error: { type: errorType(status), message } }, headers);
}
