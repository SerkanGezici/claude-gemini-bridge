# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-11-27

### Fixed
Found by running every installed skill and plugin through the bridge:
- A skill requested by name is loaded with the Skill tool, using the exact name: no invented sub-names, no searching for it with ToolSearch.
- Gemini's `web_search` called together with another tool reached Claude Code as an unknown tool ("No such tool available: web_search"). The bridge now runs it itself and merges the result.
- Answers claiming a web search or a created file that never happened are caught deterministically, also on the full-replay path and after the reviewer's correction turn. Searches the bridge ran itself count as evidence.
- A turn that ended with only "Let me check" (or nothing) after a tool result is sent back for one correction turn.
- `[tool_use: …]` text written by the model is turned into a real tool call on every path.
- Commit attribution lines no longer leak into plain answers; the browser skill never closes the user's existing tabs.

## [0.2.1] - 2026-11-26

### Fixed
- `--setup-docs` on Windows picked the newest Python via `py -3` (e.g. 3.15), for which the pinned packages have no wheels ("No matching distribution found for onnxruntime"). It now prefers Python 3.13 → 3.12 → 3.11 → 3.14 and prints the version it uses.

### Added
- Install smoke workflow: README's one-command install, `--help` and `--setup-docs` on Linux, macOS and Windows.

## [0.2.0] - 2026-11-26

### Added
- **One-command install** from the public GitHub release: `npm install -g https://github.com/SerkanGezici/claude-gemini-bridge/releases/latest/download/claude-gemini-bridge.tgz`.
- **Document editing tools** (ADR-0004): pinned Python environment (`claude-gemini --setup-docs`), an `office` MCP server (inspect / compare for xlsx, docx, pptx, pdf, images) and hooks that analyse the document before the edit and compare the result with the original after it.
- Desktop control (computer use) and browser MCP wiring, reviewer (Claude audits Gemini's answer), table-to-image rendering.

### Fixed
- An invalid `GEMINI_API_KEY` in the shell no longer forces re-entering the key: the saved key is used.
- Excel "repair" prompt caused by openpyxl 3.1.2 (docenv pins 3.1.5).

## [0.1.1] - 2026-11-12

### Added
- README **hero / architecture diagram** (`docs/hero.png`): numbered Claude Code → Bridge → Transform → Gemini Live → Stream-back flow plus a built-in-features lane.
- **Interactive first-run API-key setup.** On startup in a terminal, the key is validated; if it is missing or invalid/expired, you are prompted to paste one, it is validated against the API and saved to `~/.config/claude-gemini-bridge/.env`. Re-validated on every launch so revoked/deactivated keys are caught immediately. No-op in non-TTY/CI; skip with `SKIP_KEY_CHECK=1`.
- MIT `LICENSE`.
- English `README.md` (primary) plus Turkish `README.tr.md`.
- `SECURITY.md` with the threat model and responsible-disclosure process.
- `CONTRIBUTING.md`.
- GitHub Actions CI (`typecheck` + tests on Node 20/22) and a gitleaks secret scan.
- Build step: TypeScript is compiled to `dist/` (`npm run build`, also run via `prepare`/`prepublishOnly`).
- `engines`, `files`, `repository`, `homepage`, `bugs`, `keywords` fields in `package.json`.
- Per-user config location for the API key: `~/.config/claude-gemini-bridge/.env` (useful for global installs).

### Changed
- The published CLI now runs the **compiled** `dist/index.js` with plain Node — `tsx` is no longer a runtime dependency.
- `package.json` `files` whitelist so `npm publish` ships only `dist/`, `bin/`, the READMEs, `LICENSE`, and `.env.example`.
- `--help` output and `.env.example` are now in English with the correct default model name.
- All user-facing CLI output is now in English: first-run key prompts, startup/diagnostic logs, and thrown error messages (config validation, HOST, port).
- Test fixtures anonymized — no real personal data in the repository.
- `GET /v1/models` now lists current Claude model IDs (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`) instead of retired ones; Gemini still generates every answer.

## [0.1.0]
- Initial working bridge: Claude Code CLI ↔ Gemini Live API, with tool calls,
  streaming, quota fallback, empty-turn resilience, and real-time web search.
