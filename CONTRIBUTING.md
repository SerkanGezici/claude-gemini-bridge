# Contributing to claude-gemini-bridge

Thanks for your interest! This is a small, focused project — a bridge that runs
the Claude Code CLI on top of the Gemini Live API. Contributions are welcome.

## Getting started

```bash
git clone https://github.com/SerkanGezici/claude-gemini-bridge.git
cd claude-gemini-bridge
npm install            # installs deps and builds dist/ (via the "prepare" script)
cp .env.example .env   # add your GEMINI_API_KEY
```

## Before opening a pull request

Please make sure these pass locally:

```bash
npm run typecheck   # tsc --noEmit, source + tests
npm test            # unit tests (no API key required)
npm run build       # confirms the dist/ build still compiles
```

CI runs the same checks on Node 20 and 22 for every PR.

## Guidelines

- **Add tests for new behavior.** Bug fixes and features should come with unit tests under `tests/unit/`.
- **Keep secrets out of the repo.** Never commit a real `.env`, API key, or log file. `.env`, `logs/`, and `dist/` are git-ignored.
- **Match the existing style.** TypeScript, ESM (`.js` import extensions), `strict` mode.
- **Live behavior matters.** Some behavior only shows up at runtime (routing, model quirks). For non-trivial changes, verify against a real bridge session, not just unit tests.

## Project tracking

Work is tracked in a single master backlog: [`PLANS/ACTIVE_PLAN.md`](./PLANS/ACTIVE_PLAN.md).
New findings get added there with an ID rather than in scattered files.

## Reporting bugs / security issues

- Bugs: open a [GitHub issue](https://github.com/SerkanGezici/claude-gemini-bridge/issues).
- Security vulnerabilities: **do not** open a public issue — see [SECURITY.md](./SECURITY.md).
