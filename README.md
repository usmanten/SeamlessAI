# SeamlessAI

Keep coding when your AI credits run out. SeamlessAI runs a local OpenAI-compatible endpoint that sends each request to a free AI provider and automatically falls back to the next one when a provider hits its rate limit, rejects a key, or goes down.

Any tool that lets you set a custom OpenAI base URL (Cursor, Continue, Aider, Cline, the OpenAI SDKs, ...) can use it unchanged.

## Quick start

Requires Node.js 20 or newer. No dependencies.

```sh
git clone https://github.com/usmanten/SeamlessAI.git
cd SeamlessAI
npm link            # installs the `seamless` command

seamless providers  # see which providers are ready
seamless start      # http://127.0.0.1:4141/v1
```

Two providers (Kilo Code gateway and OVHcloud) work with no key, so `seamless start` works on first run. Add free keys for the faster, more generous providers:

```sh
seamless keys set nvidia   <key>   # https://build.nvidia.com
seamless keys set groq     <key>   # https://console.groq.com/keys
seamless keys set cerebras <key>   # optional: a trial that asks for a card
```

Keys are stored in `~/.seamless/config.json` (readable only by you). Environment variables `NVIDIA_API_KEY`, `GROQ_API_KEY` and `CEREBRAS_API_KEY` take precedence. Keys are only ever sent over https.

Then point your tool at:

| Setting  | Value                      |
|----------|----------------------------|
| Base URL | `http://127.0.0.1:4141/v1` |
| API key  | anything (it is ignored)   |
| Model    | `auto`                     |

Try it from the terminal without a tool:

```sh
seamless ask "write a python one-liner that reverses a string"
```

## Choosing a model

- `auto` tries the best-ranked model first (see below).
- `groq` or `groq/openai/gpt-oss-120b` tries that provider or model first, and keeps the others as fallback.
- `GET /v1/models` lists every usable `provider/model` id.

Each response carries `x-seamless-provider` and `x-seamless-model` headers saying who answered.

## How models are ranked

For each request SeamlessAI first rules out models that can't take it:

- the request uses tools and the model can't,
- the request is bigger than the model's context, or than the provider's tokens-per-minute limit (Groq's free tier allows only 8,000),
- the provider is out of requests or tokens for now,
- private mode is on (`seamless private on`) and the provider may log or train on prompts.

The rest are tried best first. Each gets a score out of 100:

| Part | Weight | Where it comes from |
|------|--------|---------------------|
| Quality | 40% | Your `seamless test` score, else the catalog's tier (strong 80, good 60, unknown 40) |
| Reliability | 25% | Share of its last 20 requests that came back with a usable answer |
| Speed | 15% | Average time to answer over its last 20 successes, else its test timing |
| Headroom | 10% | How much of today's request and token allowance is left |
| Stability | 10% | Permanent free tier 100, promo or trial 50 |

Rate limits and key problems don't count against reliability. Live numbers start fresh each time `seamless start` runs. The weights live in `providers.json` under `ranking.weights`. `GET /health` shows every model's current score.

### Testing models

```sh
seamless test            # every usable model
seamless test nvidia     # one provider
seamless test groq/openai/gpt-oss-120b --only tool-call,basic
```

Five short tests, each sending a made-up prompt (never your code): follow a simple instruction, call a tool with valid arguments, use tool results over several rounds, fix a one-line bug, and find a detail in a ~4,000-token log. Answers are checked with plain text and JSON checks; nothing a model writes is ever run. Scores are saved to `~/.seamless/probes.json` and used by `seamless start`. Testing uses your free quota (about 7 requests per model) and waits out short rate limits. Tests that hit a rate limit are skipped rather than failed, and a model needs at least 3 tests to get a score.

## How fallback works

For each request the router walks the ranked list and skips anything that is benched or at its published limit:

| Upstream result          | What happens                                                        |
|--------------------------|---------------------------------------------------------------------|
| 429 rate limited         | Bench that model (or provider) for `retry-after`, default 60s; try next |
| 401 / 403                | Bench the provider for 10 minutes (bad or missing key); try next    |
| 404                      | Bench that model for an hour (retired); try next                    |
| 5xx, timeout, no network | Bench for 30s; try next                                             |
| Other 4xx                | Try next without benching (the request may not suit that provider) |

The router also counts requests against each provider's published RPM / RPH / RPD limits and moves on before it gets a 429. If everything is exhausted, the endpoint returns 429 with a `retry-after` for the soonest provider to come back and a message listing what each provider said.

Streaming (`"stream": true`) is passed straight through. Fallback happens before the first byte; once a provider starts streaming, that provider finishes the answer.

## Providers

The provider list lives in [`providers.json`](providers.json): base URL, whether a key is needed, models in preference order, free-tier limits, privacy notes, and when the entry was last checked. To change it without editing the repo, copy it to `~/.seamless/providers.json` (or point `SEAMLESS_CATALOG` at a file) and edit that.

| Provider | Key | Free limit | Notes |
|----------|-----|------------|-------|
| NVIDIA NIM | free, needs signup | 40 RPM, 10,000/day per model | Strongest free coding models (Kimi K3, GLM 5.3, DeepSeek V4.1). NVIDIA says free access is for prototyping, development and testing |
| Groq | free | 30 RPM, 1,000/day, 8,000 tokens/min per model | Very fast; too small for big agent requests |
| Cerebras | trial, asks for a card | 5 RPM, 30,000 tokens/min, 1M tokens/day per model | Fast; optional |
| Kilo Code gateway | none | 200/hour per IP | Free pool rotates; may log prompts |
| OVHcloud AI Endpoints | none | 2 RPM per IP per model | EU-hosted; last resort |

Free tiers change often. Use your own accounts and keys; don't share or pool keys.

## Security

- The server listens on `127.0.0.1` only, and refuses requests that come from web pages (any `Origin` other than localhost) or carry an unexpected `Host` header, so a website you visit can't use your keys or quota. Using `--host 0.0.0.0` shares it with your network and prints a warning.
- Keys are never sent over plain http, except to this machine.
- `~/.seamless/` files are readable only by you.

## Development

```sh
npm test   # runs against fake local providers, no network needed
```

## License

SeamlessAI is free software under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). You can use, change, and share it; if you share a changed version, or run one as a service other people use over a network, you must make your source code available under the same license.
