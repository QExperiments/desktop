# Shared agent rules

Tool-agnostic project rules. Keep each file to one concern.

| Rule | When to apply |
| --- | --- |
| [non-negotiables.md](rules/non-negotiables.md) | Always |
| [git-workflow.md](rules/git-workflow.md) | Branches, commits, push policy |
| [qvac-sdk.md](rules/qvac-sdk.md) | Any AI / model / RAG / P2P work |
| [eval-and-api.md](rules/eval-and-api.md) | HTTP API, eval harness, citations |

Claude Code loads the same topics from `../.claude/rules/`.
The always-on summary is `../AGENTS.md`.
