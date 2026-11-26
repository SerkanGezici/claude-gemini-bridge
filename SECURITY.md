# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in ClaudeCLILive, please report it
**privately** — do not open a public issue for security problems.

- Preferred: open a [GitHub Security Advisory](https://github.com/SerkanGezici/claude-gemini-bridge/security/advisories/new).
- Alternatively, contact the maintainer via the email on the GitHub profile.

Please include steps to reproduce, affected version/commit, and impact. We aim
to acknowledge reports within a few days.

## Scope and threat model

This project is a **local bridge / API proxy**. It:

- Holds your `GEMINI_API_KEY` in memory and reads it from a local `.env` file.
- Exposes an Anthropic-compatible HTTP endpoint, **bound to `127.0.0.1` by default**.
- Protects that endpoint with a `BRIDGE_TOKEN` (auto-generated per start if unset).

### Your responsibilities

- **Never commit your `.env`.** Only `.env.example` (placeholders) is tracked; `.env` is git-ignored.
- **Keep `HOST=127.0.0.1`.** Do not bind the bridge to `0.0.0.0` or expose it to a network/the internet — doing so would let others use your API key.
- **Set a strong `BRIDGE_TOKEN`** in shared or multi-user environments.
- Rotate your Gemini API key immediately if you suspect it has leaked.

### Out of scope

- Vulnerabilities in upstream dependencies (Claude Code, the Gemini API, Fastify, `@google/genai`) — report those to their respective projects.
- Misconfiguration that exposes the bridge to untrusted networks (see above).

## Supported versions

This is a `0.x` project; only the latest `main` is supported. Pin a commit if
you need stability.
