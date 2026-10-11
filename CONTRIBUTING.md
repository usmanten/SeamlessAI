# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Getting started

```sh
git clone https://github.com/usmanten/SeamlessAI.git
cd SeamlessAI
npm test
```

Node.js 20 or newer is all you need. There are no dependencies, and please keep it that way: anything Node.js doesn't provide needs a very good reason.

## How the code is laid out

| File | What it does |
|------|--------------|
| `providers.json` | The provider catalog: URLs, models, free-tier limits, test scores |
| `src/router.js` | Ranks models for each request, falls back on failures, tracks rate limits |
| `src/server.js` | The local HTTP server and its routes |
| `src/anthropic.js`, `src/responses.js` | Translate Anthropic Messages and OpenAI Responses requests to chat completions and back |
| `src/trim.js` | Fits a long conversation to a smaller model |
| `src/probe.js` | `seamless test`, the model test suite |
| `src/relay.js`, `src/sessions.js`, `src/handoff.js` | `seamless code`: runs the tools, spots a used-up plan, carries the work over |
| `src/cli.js`, `src/setup.js`, `src/background.js` | Commands, guided setup, the background server |

## Pull requests

- Add or update a test for what you change. Tests run against fake local providers and never touch the network.
- Run `npm test` before pushing; it also runs on Windows, macOS and Linux for every pull request.
- Updating a provider's limits or models? Say where the numbers came from in its `verified` field.

## Releasing (maintainer)

SeamlessAI is published to npm as `seamlessai`.

1. Bump the version: `npm version patch` (bug fixes) or `npm version minor` (new features). This updates `package.json` and makes a git tag.
2. `git push --follow-tags`
3. `npm publish`. The tests run first and the publish stops if any fail.

`npm pack --dry-run` lists exactly which files a release would include.

By contributing you agree that your contribution is licensed under the project's license (AGPL-3.0-only).
