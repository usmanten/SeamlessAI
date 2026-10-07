import { keyFor, isUsable } from './config.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Ranking. Every part is 0-100; the total is their weighted sum. A catalog can
// override the weights with { "ranking": { "weights": { ... } } }.
export const DEFAULT_WEIGHTS = { quality: 0.4, reliability: 0.25, speed: 0.15, headroom: 0.1, stability: 0.1 };
const QUALITY_BY_TIER = { strong: 80, good: 60 };
const STABILITY = { permanent: 100, promo: 50, trial: 50, new: 30 };
const STATS_WINDOW = 20; // live outcomes and latencies kept per model

// How long to bench a provider or model after each kind of failure, when the
// upstream does not say (retry-after wins when present).
const COOLDOWN = {
  rateLimited: MINUTE,
  badKey: 10 * MINUTE,
  modelMissing: HOUR,
  serverError: 30_000,
  network: 30_000,
};

export class AllProvidersFailed extends Error {
  constructor(attempts, retryAfterMs) {
    super('All providers failed or are rate limited');
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Picks a provider for each request and falls back to the next one when a
 * provider is rate limited, down, or rejects the request.
 */
export class Router {
  constructor({ catalog, config, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 60_000, log = () => {}, probes = {} }) {
    this.catalog = catalog;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.cooldowns = new Map(); // bucket -> { until, reason }
    this.usage = new Map(); // bucket -> request timestamps
    this.tokens = new Map(); // bucket -> [{ t, n }] estimated tokens sent
    this.stats = new Map(); // target id -> { outcomes: [bool], latencies: [ms] }
    this.probes = probes; // target id -> { score, testedAt } from `seamless test`
  }

  /** Every usable provider/model pair, in catalog order. */
  targets() {
    const list = [];
    for (const provider of this.catalog.providers) {
      if (!isUsable(provider, this.config)) continue;
      for (const model of provider.models) {
        list.push({ id: `${provider.id}/${model.id}`, provider, model });
      }
    }
    return list;
  }

  /**
   * Orders targets for a requested model name. "auto" (or anything unknown)
   * uses the ranking (catalog order breaks ties); "groq", "groq/<model>" or a bare upstream model id
   * moves the matching targets to the front and keeps the rest as fallback.
   */
  plan(requested) {
    const all = this.rank(this.targets());
    if (!requested || requested === 'auto') return all;
    const preferred = all.filter((t) => t.id === requested || t.provider.id === requested || t.model.id === requested);
    return [...preferred, ...all.filter((t) => !preferred.includes(t))];
  }

  /** Targets sorted by score, highest first; equal scores keep catalog order. */
  rank(list) {
    const scored = list.map((target, i) => ({ target, i, score: this.score(target).total }));
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.map((s) => s.target);
  }

  /** How good a choice a target is right now, overall and by part (0-100). */
  score(target) {
    const { model, provider } = target;
    const live = this.stats.get(target.id) || { outcomes: [], latencies: [] };
    const parts = {
      quality: this.probes[target.id]?.score ?? model.qualityScore ?? QUALITY_BY_TIER[model.tier] ?? 40,
      // Too few samples to judge: assume decent until shown otherwise.
      reliability: live.outcomes.length < 3 ? 80 : (100 * live.outcomes.filter(Boolean).length) / live.outcomes.length,
      // Unmeasured models score as fast so they get tried and measured.
      speed: live.latencies.length === 0 ? 100 : clamp(100 - (average(live.latencies) - 1000) / 290),
      headroom: this.headroom(target),
      stability: STABILITY[model.stability ?? provider.stability] ?? 70,
    };
    const weights = { ...DEFAULT_WEIGHTS, ...this.catalog.ranking?.weights };
    let total = 0;
    for (const [part, weight] of Object.entries(weights)) total += (parts[part] ?? 0) * weight;
    return { total: Math.round(total * 10) / 10, parts };
  }

  /**
   * Share of today's allowance left (requests and tokens per day). Per-minute
   * and per-hour limits recover quickly, so they only block, they don't rank.
   */
  headroom(target) {
    const limits = limitsOf(target);
    const bucket = this.limitBucket(target);
    const since = this.now() - DAY;
    let left = 1;
    if (limits.rpd) left = Math.min(left, 1 - (this.usage.get(bucket) || []).filter((t) => t > since).length / limits.rpd);
    if (limits.tpd) left = Math.min(left, 1 - tokensSince(this.tokens.get(bucket), since) / limits.tpd);
    return clamp(left * 100);
  }

  /**
   * Why a target can never take this request (no tools, too big, private
   * mode), or null if it can. Unlike blockedFor, waiting won't help.
   */
  unfitFor(target, need) {
    const { model, provider } = target;
    if (need.tools && model.tools === false) return 'model cannot use tools';
    if (model.context && need.tokens > model.context) return `request (~${need.tokens} tokens) is bigger than its ${model.context}-token context`;
    const { tpm } = limitsOf(target);
    if (tpm && need.tokens > tpm) {
      return `request (~${need.tokens} tokens) is bigger than its ${tpm} tokens/minute limit`;
    }
    if (keyFor(provider, this.config) && !safeForKey(provider.baseUrl)) return 'its key would be sent over plain http';
    if (this.config.privateMode && (provider.mayLogPrompts || provider.trainsOnPrompts)) return 'private mode: provider may log or train on prompts';
    return null;
  }

  status() {
    return this.catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      usable: isUsable(provider, this.config),
      needsKey: Boolean(provider.auth?.required),
      hasKey: Boolean(keyFor(provider, this.config)),
      models: provider.models.map((model) => {
        const target = { id: `${provider.id}/${model.id}`, provider, model };
        const blocked = this.blockedFor(target);
        const { total, parts } = this.score(target);
        return { id: model.id, available: !blocked, blockedMs: blocked?.ms ?? 0, reason: blocked?.reason ?? null, score: total, scoreParts: parts };
      }),
    }));
  }

  /**
   * Sends an OpenAI chat-completions body through the fallback chain. Resolves
   * with the first successful upstream Response; the caller streams its body.
   */
  async dispatch(body, { signal } = {}) {
    const attempts = [];
    let soonest = Infinity;
    const need = requestNeeds(body);

    for (const target of this.plan(body.model)) {
      const unfit = this.unfitFor(target, need);
      if (unfit) {
        attempts.push({ target: target.id, skipped: unfit });
        continue;
      }
      const blocked = this.blockedFor(target, need);
      if (blocked) {
        soonest = Math.min(soonest, blocked.ms);
        attempts.push({ target: target.id, skipped: blocked.reason });
        continue;
      }

      const started = this.now();
      this.recordUse(target, need.tokens);
      let res;
      try {
        res = await this.send(target, body, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        const timedOut = err.name === 'TimeoutError';
        const reason = timedOut ? 'timed out' : `network error: ${err.message}`;
        // A slow model says nothing about the provider's other models; a
        // network failure usually does.
        this.bench(timedOut ? target.id : this.providerBucket(target), COOLDOWN.network, reason);
        this.recordOutcome(target, false);
        attempts.push({ target: target.id, error: reason });
        this.log(`  ✗ ${target.id} ${reason}`);
        continue;
      }

      // Some providers answer 200 with an error in the body (e.g. "upstream
      // overloaded"), so a 200 only counts once the body looks like an answer.
      let outcome;
      try {
        outcome = res.ok ? await inspectBody(res) : { status: res.status, error: await readSnippet(res) };
      } catch (err) {
        if (signal?.aborted) throw err;
        outcome = { status: 502, error: `broken response: ${err.message}` };
      }

      const ms = this.now() - started;
      if (outcome.response) {
        this.recordOutcome(target, true, ms);
        this.log(`  ✓ ${target.id} ${res.status} ${ms}ms`);
        return { response: outcome.response, target, attempts };
      }

      attempts.push({ target: target.id, status: outcome.status, error: outcome.error });
      this.log(`  ✗ ${target.id} ${outcome.status} ${ms}ms ${outcome.error}`);
      this.onFailure(target, outcome.status, res.headers);
      // Rate limits, key problems and other 4xx say nothing about whether the
      // model works, so only outages and broken answers count against it.
      if (outcome.status >= 500 || outcome.status === 404) this.recordOutcome(target, false);
    }

    throw new AllProvidersFailed(attempts, Number.isFinite(soonest) ? soonest : null);
  }

  async send(target, body, signal) {
    const headers = { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' };
    const url = `${target.provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const key = keyFor(target.provider, this.config);
    if (key) {
      // Never send a key where it can be read in transit.
      if (!safeForKey(url)) throw new Error(`refusing to send an API key over plain http to ${new URL(url).host}`);
      headers.authorization = `Bearer ${key}`;
    }

    // The timeout covers waiting for response headers; a stream that has
    // started is allowed to run as long as it needs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Upstream timed out', 'TimeoutError')), this.timeoutMs);
    const onClientAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onClientAbort, { once: true });
    try {
      return await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, model: target.model.id }),
        signal: controller.signal,
      });
    } catch (err) {
      throw controller.signal.reason instanceof DOMException ? controller.signal.reason : err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onClientAbort);
    }
  }

  onFailure(target, s, headers) {
    const retryAfter = parseRetryAfter(headers.get('retry-after'), this.now());
    if (s === 429) {
      this.bench(this.limitBucket(target), retryAfter ?? COOLDOWN.rateLimited, 'rate limited');
    } else if (s === 401 || s === 403) {
      this.bench(this.providerBucket(target), COOLDOWN.badKey, 'key rejected');
    } else if (s === 404) {
      this.bench(target.id, COOLDOWN.modelMissing, 'model not found');
    } else if (s >= 500) {
      this.bench(target.id, retryAfter ?? COOLDOWN.serverError, `server error ${s}`);
    }
    // Other 4xx (bad params, context too long) are about this request, not
    // the provider: try the next one without benching anything.
  }

  bench(bucket, ms, reason) {
    const until = this.now() + ms;
    const current = this.cooldowns.get(bucket);
    if (!current || current.until < until) this.cooldowns.set(bucket, { until, reason });
  }

  providerBucket(target) {
    return target.provider.id;
  }

  limitBucket(target) {
    return target.provider.limits?.scope === 'model' ? target.id : target.provider.id;
  }

  /** Why a target can't be used right now, or null if it can. */
  blockedFor(target, need = { tokens: 0 }) {
    const now = this.now();
    for (const bucket of new Set([target.id, target.provider.id])) {
      const c = this.cooldowns.get(bucket);
      if (c && c.until > now) return { ms: c.until - now, reason: c.reason };
    }

    // Stay under published limits instead of waiting to be told off.
    const limits = limitsOf(target);
    const stamps = this.usage.get(this.limitBucket(target)) || [];
    for (const [field, window] of [['rpm', MINUTE], ['rph', HOUR], ['rpd', DAY]]) {
      if (!limits[field]) continue;
      const inWindow = stamps.filter((t) => t > now - window);
      if (inWindow.length >= limits[field]) {
        return { ms: inWindow[0] + window - now, reason: `${field} limit reached` };
      }
    }
    const sent = this.tokens.get(this.limitBucket(target)) || [];
    for (const [field, window] of [['tpm', MINUTE], ['tpd', DAY]]) {
      if (!limits[field]) continue;
      const inWindow = sent.filter((e) => e.t > now - window);
      let used = inWindow.reduce((sum, e) => sum + e.n, 0);
      if (used + need.tokens <= limits[field]) continue;
      // Wait until enough of the window has rolled off for this request to fit.
      let ms = window;
      for (const e of inWindow) {
        used -= e.n;
        if (used + need.tokens <= limits[field]) {
          ms = e.t + window - now;
          break;
        }
      }
      return { ms, reason: `${field} limit reached` };
    }
    return null;
  }

  recordUse(target, tokens = 0) {
    const bucket = this.limitBucket(target);
    const now = this.now();
    const stamps = (this.usage.get(bucket) || []).filter((t) => t > now - DAY);
    stamps.push(now);
    this.usage.set(bucket, stamps);
    if (tokens > 0) {
      const sent = (this.tokens.get(bucket) || []).filter((e) => e.t > now - DAY);
      sent.push({ t: now, n: tokens });
      this.tokens.set(bucket, sent);
    }
  }

  recordOutcome(target, ok, ms) {
    const live = this.stats.get(target.id) || { outcomes: [], latencies: [] };
    live.outcomes = [...live.outcomes, ok].slice(-STATS_WINDOW);
    if (ok && ms !== undefined) live.latencies = [...live.latencies, ms].slice(-STATS_WINDOW);
    this.stats.set(target.id, live);
  }
}

/**
 * What a request asks of a model: whether it uses tools, and roughly how many
 * tokens it takes up, plus the reply budget. Code, numbers and JSON run close
 * to 3 characters per token (Groq counted ~2.6 for a log full of numbers), so
 * this errs high: better to skip a provider than to be refused by it.
 */
export function requestNeeds(body) {
  const chars = JSON.stringify(body.messages ?? []).length + (body.tools ? JSON.stringify(body.tools).length : 0);
  const reply = Number(body.max_completion_tokens ?? body.max_tokens) || 0;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, tokens: Math.ceil(chars / 3) + reply };
}

/** Keys only travel over https, or plain http to this machine. */
export function safeForKey(url) {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/** Provider limits, with any per-model overrides (some models have tighter ones). */
function limitsOf(target) {
  return { ...target.provider.limits, ...target.model.limits };
}

function tokensSince(entries = [], since) {
  return entries.reduce((sum, e) => (e.t > since ? sum + e.n : sum), 0);
}

function average(list) {
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function clamp(n) {
  return Math.max(0, Math.min(100, n));
}

export function parseRetryAfter(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Checks a 200 response for an error hidden in the body. Returns
 * { response } with an equivalent, still-unread Response when it looks like a
 * real answer, or { status, error } when it doesn't. For streams only the
 * first chunk is examined; once a stream has started it is passed through.
 */
async function inspectBody(res) {
  const init = { status: res.status, headers: res.headers };
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 502, error: 'provider sent a response that is not JSON' };
    }
    return errorIn(json) || { response: new Response(text, init) };
  }

  const reader = res.body.getReader();
  const first = await reader.read();
  if (first.done) return { status: 502, error: 'provider sent an empty stream' };
  const dataLine = new TextDecoder().decode(first.value).split('\n').find((l) => l.startsWith('data:'));
  try {
    const failure = errorIn(JSON.parse(dataLine.slice(5)));
    if (failure) {
      reader.cancel().catch(() => {});
      return failure;
    }
  } catch {
    // No complete JSON event in the first chunk: nothing to judge yet.
  }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { response: new Response(stream, init) };
}

export function errorIn(json) {
  if (json?.error) {
    const e = json.error;
    const code = Number(typeof e === 'object' ? e.code ?? e.status : json.code);
    const message = typeof e === 'object' ? e.message || JSON.stringify(e) : String(e);
    return { status: code >= 400 && code <= 599 ? code : 502, error: message.replace(/\s+/g, ' ').slice(0, 200) };
  }
  if (!Array.isArray(json?.choices)) return { status: 502, error: 'provider response had no choices' };
  return null;
}

export async function readSnippet(res) {
  try {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json.error?.message || json.message || json.detail || text;
    } catch {}
    return String(message).replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    return '';
  }
}
