import http from 'node:http';
import { Readable } from 'node:stream';
import { AllProvidersFailed } from './router.js';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * A local OpenAI-compatible server. Point any tool that accepts a custom
 * base URL at http://127.0.0.1:<port>/v1 and use model "auto".
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
      sendError(res, 404, `No route for ${req.method} ${url.pathname}`, 'not_found');
    } catch (err) {
      log(`! ${err.stack || err.message}`);
      if (!res.headersSent) sendError(res, 500, err.message, 'internal_error');
      else res.destroy(err);
    }
  });
}

async function chatCompletions(router, req, res, log) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendError(res, 400, `Invalid JSON body: ${err.message}`, 'invalid_request_error');
  }
  if (!Array.isArray(body.messages)) {
    return sendError(res, 400, '"messages" must be an array', 'invalid_request_error');
  }

  // Stop upstream work if the client hangs up.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  log(`→ chat ${body.model || 'auto'}${body.stream ? ' (stream)' : ''}`);
  let result;
  try {
    result = await router.dispatch(body, { signal: abort.signal });
  } catch (err) {
    if (abort.signal.aborted) return;
    if (!(err instanceof AllProvidersFailed)) throw err;
    const headers = err.retryAfterMs ? { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) } : {};
    const tried = err.attempts.map((a) => (a.skipped ? `${a.target}: skipped (${a.skipped})` : `${a.target}: ${a.status ?? ''} ${a.error ?? ''}`.trim()));
    const message = err.attempts.length
      ? `All providers failed or are rate limited. ${tried.join('; ')}`
      : 'No providers are usable. Add a key with `seamless keys set <provider> <key>` or check `seamless providers`.';
    return sendError(res, 429, message, 'all_providers_exhausted', headers);
  }

  const { response, target, trimmed } = result;
  const headers = {
    'content-type': response.headers.get('content-type') || 'application/json',
    'cache-control': 'no-cache',
    'x-seamless-provider': target.provider.id,
    'x-seamless-model': target.model.id,
  };
  // The conversation didn't fit any model whole: say what was cut (the
  // router has already logged it).
  if (trimmed) headers['x-seamless-trimmed'] = trimmed.summary;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  Readable.fromWeb(response.body)
    .on('error', (err) => {
      log(`! stream from ${target.id} broke: ${err.message}`);
      res.destroy(err);
    })
    .pipe(res);
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
