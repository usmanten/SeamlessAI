# SeamlessAI

Keep coding when your AI credits run out. SeamlessAI runs a local OpenAI-compatible endpoint that sends each request to a free AI provider and automatically falls back to the next one when a provider hits its rate limit, rejects a key, or goes down.

Any tool that lets you set a custom OpenAI base URL (Continue, Aider, Cline, the OpenAI SDKs, ...) can use it unchanged. It also speaks Anthropic's format for [Claude Code](#claude-code) and OpenAI's Responses format for [Codex](#codex).

With [`seamless code`](#the-relay-seamless-code), it also runs Claude Code and Codex for you, on your own accounts first, and switches to the next one (and finally to free models) when one runs out of usage, carrying your work over.

## Quick start

Requires Node.js 20 or newer. No dependencies.

```sh
git clone https://github.com/usmanten/SeamlessAI.git
cd SeamlessAI
npm link            # installs the `seamless` command
seamless setup      # keys, the relay order, and a quick check

cd ~/my-project
seamless code       # Claude Code / Codex, switching when one runs out
```

Or run the endpoint yourself for any other tool:

```sh
seamless providers  # see which providers are ready
seamless start      # http://127.0.0.1:4141/v1 (add --background to not keep the window open)
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

## Claude Code

Claude Code uses Anthropic's Messages API rather than OpenAI's. SeamlessAI accepts it at `/v1/messages`, translates each request for the free providers (tool calls and streaming included), and translates the answer back. Start `seamless start`, then start Claude Code with these set:

```sh
# macOS / Linux
export ANTHROPIC_BASE_URL=http://127.0.0.1:4141
export ANTHROPIC_AUTH_TOKEN=seamless
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude
```

```powershell
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:4141"
$env:ANTHROPIC_AUTH_TOKEN = "seamless"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
claude
```

The base URL has no `/v1` (Claude Code adds it). The token can be anything. No Claude account or credits are used.

What to expect:
- Claude's model names (`claude-sonnet-...`, `claude-haiku-...`) mean `auto`. To prefer a provider or model, set `ANTHROPIC_MODEL`, e.g. `ANTHROPIC_MODEL=nvidia/z-ai/glm-5.3`. Claude Code warns once that it doesn't recognize that name; the warning is harmless.
- Claude Code works by calling tools, so its requests only go to models marked `"tools": true` in the catalog (ones that passed `seamless test`'s tool checks). Other models are skipped for these requests.
- Every Claude Code request carries about 20,000 tokens of instructions and tool descriptions. Groq's free tier allows 8,000 tokens a minute, so these requests go to NVIDIA and Kilo instead. An NVIDIA key makes Claude Code much more dependable.
- Not passed on: Anthropic's built-in web search (it only runs on Anthropic's servers), PDFs, images inside tool results, and Claude's extended thinking. The free model's own reasoning is not shown.

## Codex

Codex speaks OpenAI's Responses API, which SeamlessAI accepts at `/v1/responses` and translates for the free providers (tool calls, Codex's freeform patch tool and streaming included). `seamless setup` (or the first `seamless code` that needs it) writes a Codex profile to `~/.codex/seamless.config.toml`, so Codex runs on free models with:

```sh
codex --profile seamless
```

Your own `~/.codex/config.toml` is not changed. Like Claude Code's, Codex's requests only go to models marked `"tools": true`. Codex's hosted web search and its sub-agent tools aren't passed on, and it warns once that it doesn't know the model `auto`; the warning is harmless.

## The relay: `seamless code`

Run `seamless code` in your project folder instead of `claude` or `codex`. It opens your coding tools one at a time, in an order you choose:

```sh
seamless relay                         # show the order
seamless relay codex, claude, claude-free
```

| Step          | What runs                                          |
|---------------|----------------------------------------------------|
| `claude`      | Claude Code on your own account                    |
| `codex`       | Codex on your own account                          |
| `claude-free` | Claude Code on SeamlessAI's free models            |
| `codex-free`  | Codex on SeamlessAI's free models                  |

The default is each tool you have installed, then free models. When a tool runs out of usage, SeamlessAI closes it and opens the next step:

- **Same tool** (Claude Code on your account, then on free models): the same conversation is reopened and continues by itself.
- **Different tool** (Codex, then Claude Code): the new tool can't open the old one's conversation, so SeamlessAI writes `.seamless/handoff.md` in your project (what you're building, what's done, what's next, and the uncommitted changes) and starts the new tool by asking it to read the note. A free model writes the summary from the old session: your requests, the replies and one line per tool call, without tool output or file contents. The `.seamless` folder ignores itself in git.

How SeamlessAI knows a tool ran out: both tools save each conversation on your computer (`~/.claude/projects` and `~/.codex/sessions`) and mark a used-up plan with a code (`rate_limit` and `usage_limit_exceeded`). SeamlessAI only reads those files. Your logins stay inside Claude Code and Codex, which talk to Anthropic and OpenAI as usual; SeamlessAI never sees or uses them. A tool that ran out is skipped by later `seamless code` runs until it resets (Claude Code says when; Codex is tried again after an hour).

If you close a tool yourself, SeamlessAI asks whether to switch to the next one; the same conversation then reopens and waits for you instead of continuing by itself. `seamless code --from codex` starts at a later step.

On free models, Claude Code lets file edits through and asks before running commands, except read-only ones (`git status`, `git diff`, `git log`, `git show`, `ls`, `dir`, `pwd`), which just run. Its auto mode would have a model check every tool call first, and on the free step that model is a free one (which may log prompts, and adds a few seconds per call). `seamless relay --free-mode auto` turns auto mode back on; `--free-mode ask` asks before edits too; `--free-mode edits` is the default. The server the free steps use starts in the background when needed; `seamless status` and `seamless stop` manage it.

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

## Long conversations

Coding tools resend the whole conversation with every request, so switching models mid-conversation keeps your context, as long as the conversation fits the next model. SeamlessAI handles that in two steps and only takes the second when it has to:

1. **Fit.** Models too small for the whole conversation (their context, or a tokens-per-minute limit like Groq's 8,000) are skipped, so it goes whole to the best-ranked model with room for it. If a model with room is only briefly rate limited, SeamlessAI may answer 429 with `retry-after` so your tool waits for it rather than losing anything (see the trim setting below).
2. **Trim.** If no model can take it whole, SeamlessAI trims a copy for the model with the most room, cutting in this order and stopping as soon as it fits:
   1. old command and tool output (the first 200 characters are kept so the model knows what it was),
   2. old file contents: code blocks pasted into messages, and files the model wrote out through a tool,
   3. the oldest whole turns, with a note telling the model that earlier messages were removed.

   System instructions, your latest request and the last 6 messages are never cut. If those alone don't fit, that model is skipped. A provider that refuses a request as too long also gets one trimmed retry.

You choose what happens when the only models with room are rate limited:

```sh
seamless trim             # show the current setting
seamless trim auto        # default: wait if a model with room is back within 60s, else trim
seamless trim auto 300    # same, but wait up to 5 minutes
seamless trim wait        # always wait for a model with room; trim only if none could ever fit
seamless trim off         # never trim; too-big requests fail instead
```

Trimming is always announced. The answer you see in your tool starts with a line like `[SeamlessAI trimmed this conversation to fit groq/openai/gpt-oss-120b: 3 old tool outputs shortened (~140000 -> ~120000 tokens).]` (left out when the request asks for JSON-only output, which it would break), the server log shows a `✂ trimmed for ...` line, and the response carries the same summary in an `x-seamless-trimmed` header. Your tool still has the full conversation; only what was sent to that one model was shortened. SeamlessAI stores no conversations.

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
