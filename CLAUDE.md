@AGENTS.md

## Claude Code

Project rules are in `.claude/rules/`. They match `.agents/rules/` so Claude,
Cursor, and Codex share one contract.

- Prefer **plan mode** before scaffolding runtime, models, or the HTTP server.
- When implementing QVAC calls, follow the official SDK docs
  (https://docs.qvac.tether.io) and the sibling `fibiom-electron` patterns —
  lifecycle, streaming `completion`, Zod tools, `embed` / RAG, STT/TTS —
  without copying Fibiom’s Electron or finance code.
- Keep `CLAUDE.md` and `AGENTS.md` short. Put topic detail in the rules
  directories, not here.
