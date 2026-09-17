# Evals

Scripted dialogues replayed against a live `serve`, scored by code and, for
the `single` category, by a local judge model. Everything runs on this
machine: the corpus, the answers and the judge never leave it.

```bash
npm run eval                          # tier from config.json, all categories, judge on
npm run eval -- --tier M --only tools,memory --runs 1 --no-judge
npm run eval -- --report-only results/<ts>   # rebuild report.html from a finished run
```

Results land in `evals/results/<ts>/`: `turns.jsonl` (one row per case × run
× turn with the answer, the trace fields and the code metrics), `traces/`
(copied from the server), `hardware.jsonl` (sampler ticks), `verdicts.jsonl`
(judge), `metrics.json` (aggregates), `report.html` and `report.md`.

## Case files

One JSON object per line in `cases/<category>.jsonl`. Every case has `id`
(unique, `<category>-NN`) and may have `tags` (strings such as `lang:en`,
`tier:M`) and `runs` (repeats; the default comes from `config.json`).

Document ids are paths relative to the corpus root, exactly as `search()`
returns them: `policies/warranty-terms.md`, `emails/007-sla-reminder.md`,
`data/sku-list-prices.csv`. `must` is a list of strings or regular
expressions; the check passes when at least one of them matches the answer,
case-insensitive, so give the same fact in the forms a model writes it
(`"24 months"`, `"24-month"`). Numbers in `reference` are checked
separately by `number_match`, so `reference` should carry the numbers the
answer must contain and nothing else.

| Category | Fields | Notes |
| --- | --- | --- |
| retrieval | `query`, `gold_doc_ids`, `k` (default 3) | no model call: `search(query, k)` only |
| single | `query`, `gold_doc_ids`, `reference`, `must` | full path through `serve`; the judge sees `reference` |
| abstain | `query`, `kind`: `out_of_corpus` \| `future` \| `near_miss`, `note` | the right answer is a refusal; `near_miss` names something one step from a real fact (P4 next to P1–P3, ServoDrive X5 next to X4) |
| tools | `messages` (history ending with the user query), `tool` (`lookup_stock` \| `list_documents` \| `null`), `args` (only the arguments that matter, or `null`), `must` | sent without a session, so `messages` is the whole context; `args` is matched as a subset of the call's arguments |
| memory | `turns` (each `query`, optional `must`, optional `tool`), `fact_turn`, `recall_turns` | one live session of about ten turns; the fact appears on `fact_turn` (a tool result or a document), `recall_turns` ask for it again in other words and each carries `must` |
| multiturn | `turns` (each `query`, optional `must`, `tool`, `args`, `gold_doc_ids`, `reference`, `followup`), `consistency` (pairs of 1-based turn numbers about the same fact) | one live session; `followup: true` marks an elliptical turn ("and the warranty?") |
| stress | `queries` (10–15 strings) | one live session, no expectations; the run measures error rate, empty rate, latency and memory trends |

Turn numbers are 1-based and count the user's turns.

### Examples

```jsonl
{"id":"retrieval-01","query":"What is the standard warranty for the ServoDrive X4?","gold_doc_ids":["policies/warranty-terms.md","reports/fy2026-product-catalog-excerpt.md"]}
{"id":"single-01","query":"What is the P1 first-response SLA for enterprise customers?","gold_doc_ids":["emails/007-sla-reminder.md","policies/escalation-matrix.txt","faqs/support-sla-faq.html"],"reference":"4 hours","must":["4 hours","four hours","4-hour"]}
{"id":"abstain-01","query":"What is the P4 first-response SLA?","kind":"near_miss","note":"only P1–P3 exist"}
{"id":"tools-01","messages":[{"role":"user","content":"How many ServoDrive X4 are available in EMEA?"}],"tool":"lookup_stock","args":{"sku":"SD-X4-001","region":"EMEA"},"must":["14"]}
{"id":"tools-02","messages":[{"role":"user","content":"What is the standard warranty for the ServoDrive X4?"}],"tool":null,"args":null,"must":["24 months","24-month"]}
{"id":"memory-01","turns":[{"query":"How many ServoDrive X4 are available in EMEA?","tool":"lookup_stock"},{"query":"What is the P1 SLA?"},{"query":"Remind me the EMEA stock figure for the X4.","must":["14"]}],"fact_turn":1,"recall_turns":[3]}
{"id":"stress-01","queries":["What is the P1 SLA?","How many X4 are in stock in EMEA?"]}
```

## Judge

`lib/judge/` loads the model named in `config.json` (default Qwen3.5-9B
Q4_K_M, a different and larger model than the one under test) after
`serve` has stopped, and asks for a structured verdict per `single` answer
through the SDK's `responseFormat: json_schema`. Claims are checked against
the excerpts and tool results the model was shown; `evidence` quotes are
verified by code as substrings. Enable more categories with
`judgeCategories` in `config.json` once the single run has real timing
numbers. `npm run eval -- --judge-only results/<ts>` grades a finished run
again without touching `serve`.

The judge loads with `reasoning_budget: 0`: with Qwen3.5's thinking on, the
grammar behind `responseFormat` fails ("empty grammar stack") and every
verdict would start with a thousand tokens of scratchpad. Measured on the
dev Mac (M4 Pro): about 11 s per verdict one at a time; `batchCompletion`
with four sequences (`judge.batch`, needs `parallel` at load) came out
slower at 14 s per verdict, so the default batch is 1.

### Hand labels

`cases/labels/<category>.jsonl` holds labels for answers of one run, so
that the report can print the judge's agreement with a person (Cohen's
kappa). A label names the case and the answer it was written for and then
carries the fields to compare, named as in the verdict schema:

```jsonl
{"id":"single-06","run":1,"answer_prefix":"I don't have access to the Q2","answered":"refused","correct":"no","hallucination":true}
```

`answer_prefix` is the start of the answer text; a label whose prefix no
longer matches (a new run, a different answer) is skipped, never
misapplied. Below a kappa of 0.6 the prompt in `lib/judge/prompts/` is the
thing to fix.

## Definitions

See `docs/todo.md` for the metric definitions and the measurement plan
this harness implements; `lib/metrics/*.mjs` carry the same definitions
next to the code.
