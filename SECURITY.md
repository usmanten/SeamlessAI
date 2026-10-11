# Security

SeamlessAI holds your provider API keys and runs a local server, so security problems matter. Thank you for reporting them.

## Reporting a problem

Please don't open a public issue. Report it privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You'll get a reply within a week. Once a fix is out, you'll be credited in the release notes unless you'd rather not be.

## What's in scope

- Anything that lets a website, another device on the network, or a provider read or use your API keys or quota.
- Anything that lets a free model run commands or change files without the permission checks described in the README.
- Keys or prompts written somewhere they shouldn't be (logs, the handoff note, files readable by other users).

Provider outages, rate limits and the quality of free models' answers are not security problems; please open a normal issue for those.

## Supported versions

Only the latest version on `main` gets fixes.
