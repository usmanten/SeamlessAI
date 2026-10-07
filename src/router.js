import { keyFor, isUsable } from './config.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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
  constructor({ catalog, config, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 60_000, log = () => {} }) {
    this.catalog = catalog;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.cooldowns = new Map(); // bucket -> { until, reason }
    this.usage = new Map(); // bucket -> request timestamps
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
   * uses catalog order; "groq", "groq/<model>" or a bare upstream model id
   * moves the matching targets to the front and keeps the rest as fallback.
   */
  plan(requested) {
    const all = this.targets();
    if (!requested || requested === 'auto') return all;
    const preferred = all.filter((t) => t.id === requested || t.provider.id === requested || t.model.id === requested);
    return [...preferred, ...all.filter((t) => !preferred.includes(t))];
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
        return { id: model.id, available: !blocked, blockedMs: blocked?.ms ?? 0, reason: blocked?.reason ?? null };
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

    for (const target of this.plan(body.model)) {
      const blocked = this.blockedFor(target);
      if (blocked) {
        soonest = Math.min(soonest, blocked.ms);
        attempts.push({ target: target.id, skipped: blocked.reason });
        continue;
      }

      const started = this.now();
      this.recordUse(target);
      let res;
      try {
        res = await this.send(target, body, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        const reason = err.name === 'TimeoutError' ? 'timed out' : `network error: ${err.message}`;
        this.bench(this.providerBucket(target), COOLDOWN.network, reason);
        attempts.push({ target: target.id, error: reason });
        this.log(`  ✗ ${target.id} ${reason}`);
        continue;
      }

      const ms = this.now() - started;
      if (res.ok) {
        this.log(`  ✓ ${target.id} ${res.status} ${ms}ms`);
        return { response: res, target, attempts };
      }

      const detail = await readSnippet(res);
      attempts.push({ target: target.id, status: res.status, error: detail });
      this.log(`  ✗ ${target.id} ${res.status} ${ms}ms ${detail}`);
      this.onFailure(target, res);
    }

    throw new AllProvidersFailed(attempts, Number.isFinite(soonest) ? soonest : null);
  }

  async send(target, body, signal) {
    const headers = { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' };
    const key = keyFor(target.provider, this.config);
    if (key) headers.authorization = `Bearer ${key}`;

    // The timeout covers waiting for response headers; a stream that has
    // started is allowed to run as long as it needs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Upstream timed out', 'TimeoutError')), this.timeoutMs);
    const onClientAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onClientAbort, { once: true });
    try {
      return await this.fetch(`${target.provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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

  onFailure(target, res) {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.now());
    const s = res.status;
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
  blockedFor(target) {
    const now = this.now();
    for (const bucket of new Set([target.id, target.provider.id])) {
      const c = this.cooldowns.get(bucket);
      if (c && c.until > now) return { ms: c.until - now, reason: c.reason };
    }

    // Stay under published limits instead of waiting to be told off.
    const limits = target.provider.limits || {};
    const stamps = this.usage.get(this.limitBucket(target)) || [];
    for (const [field, window] of [['rpm', MINUTE], ['rph', HOUR], ['rpd', DAY]]) {
      if (!limits[field]) continue;
      const inWindow = stamps.filter((t) => t > now - window);
      if (inWindow.length >= limits[field]) {
        return { ms: inWindow[0] + window - now, reason: `${field} limit reached` };
      }
    }
    return null;
  }

  recordUse(target) {
    const bucket = this.limitBucket(target);
    const now = this.now();
    const stamps = (this.usage.get(bucket) || []).filter((t) => t > now - DAY);
    stamps.push(now);
    this.usage.set(bucket, stamps);
  }
}

export function parseRetryAfter(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

async function readSnippet(res) {
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
