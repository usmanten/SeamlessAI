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
seamless keys set groq   <key>   # https://console.groq.com/keys
seamless keys set nvidia <key>   # https://build.nvidia.com
```

Keys are stored in `~/.seamless/config.json` (readable only by you). Environment variables `GROQ_API_KEY` and `NVIDIA_API_KEY` take precedence.

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

- `auto` tries providers in catalog order.
- `groq` or `groq/openai/gpt-oss-120b` tries that provider or model first, and keeps the others as fallback.
- `GET /v1/models` lists every usable `provider/model` id.

Each response carries `x-seamless-provider` and `x-seamless-model` headers saying who answered.

## How fallback works

For each request the router walks the fallback chain and skips anything that is benched or at its published limit:

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
| NVIDIA NIM | free, needs signup | 40 RPM, 10,000/day per model | Strongest free coding models |
| Groq | free | 30 RPM, 1,000/day per model | Very fast |
| Kilo Code gateway | none | 200/hour per IP | Free pool rotates; may log prompts |
| OVHcloud AI Endpoints | none | 2 RPM per IP per model | EU-hosted; last resort |

Free tiers change often. Use your own accounts and keys; don't share or pool keys.

## Development

```sh
npm test   # runs against fake local providers, no network needed
```

## License

SeamlessAI is free software under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). You can use, change, and share it; if you share a changed version, or run one as a service other people use over a network, you must make your source code available under the same license.
