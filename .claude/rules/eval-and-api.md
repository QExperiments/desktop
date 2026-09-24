---
paths:
  - "qvac-eval.json"
  - "**/serve*.{js,ts,mjs}"
  - "**/openai*.{js,ts,mjs}"
  - "**/http/**/*.{js,ts}"
  - "**/api/**/*.{js,ts}"
---

# Eval harness and OpenAI-compatible API

Meridian already has a chat client that talks to an OpenAI-compatible API.
The submission is scored by pointing a stock OpenAI client at us.

## `qvac-eval.json` (repo root)

Exact fields: `version`, `setup`, `start`, `shutdown`, `baseUrl`,
`readyPath`, `readyTimeoutSec`, `models.chat`, `models.embedding`.

Declared defaults we must honor unless the evaluator agrees otherwise:

- `baseUrl`: `http://127.0.0.1:11434/v1`
- `readyPath`: `/models` (poll until 200, timeout 600s)
- chat model id: `meridian-assistant`
- embedding model id: `meridian-embed`
- `setup`: `npm ci && npm run models:fetch && npm run corpus:ingest`
- `start`: `npm run serve` — **no network required**
- `shutdown`: `npm run serve:stop`

## Completions (req 6.1)

`POST /v1/chat/completions` against the declared chat model must run the
product: corpus retrieval, grounding, and tools. A pass-through to the
underlying model fails the eval.

Honor request `temperature` and `seed`.

Put sources on the assistant message as a `citations` array:

```json
{
  "file": "reports/q2-2026-sales-performance-report.md",
  "score": 0.83
}
```

`file` is required and relative to the corpus root as shipped in
`corpus.zip`. `score` is optional.
