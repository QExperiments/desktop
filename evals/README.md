# Evals

Scripted dialogues replayed against a live `serve`, scored by code and, for
the `single` category, by a local judge model. Everything runs on this
machine: the corpus, the answers and the judge never leave it.

```bash
npm run eval                          # tier from config.json, all categories, judge on
npm run eval -- --tier M --only tools,memory --runs 1 --no-judge
npm run eval -- --report-only results/<ts>   # rebuild report.html from a finished run
npm run eval -- --retrieval-only results/<ts>  # re-score retrieval in a finished run, keep its live turns
npm run eval -- --only multiquery --runs 1     # multi-question sessions: retrieval and judge per turn
npm run eval -- --judge-only results/<ts> --judge-backend claude-cli   # regrade with Haiku through `claude -p`; excerpts leave the machine
npm run eval -- --only multiquery --no-judge --variant tool-retrieval   # serve with the environment of config.json `variants.tool-retrieval`
npm run eval:compare -- results/<baseline> results/<variant> [more...]  # compare.md + compare.html: the multiquery metrics side by side
npm run eval:retrieval-exp -- --reingest --best   # retrieval-only grid of exp/retrieval-variants.json, no LLM (docs/todo-3-exp.md)
npm run eval:retrieval-exp -- --only A5,F2 --out results/retrieval-exp-<ts>   # add variants to an existing directory
npm run eval:retrieval-exp -- --report-only results/retrieval-exp-<ts>        # rebuild compare.md/html
node evals/exp/build-history-cases.mjs                                         # 74 multiquery turns with gold as retrieval cases carrying their earlier questions
npm run eval:retrieval-exp -- --variants evals/exp/history-variants.json --cases evals/exp/cases-history --out results/retrieval-history-<ts>   # query-from-history grid
npm run eval:embed-batch -- --batch 1024,4096,512 --cpu   # embed(): sequential vs array vs concurrent, order and cancel checks
```

### Retrieval experiment (ADR-013)

`retrieval-exp.mjs` runs each variant of `exp/retrieval-variants.json` in its
own process (`lib/retrieval-exp-worker.mjs`) with the variant's environment
over B0's (`EMBEDDING_MODEL`, `CHUNK_*`, `EMBED_PREFIX`, `EMBED_DIMS`,
`CHUNK_HEADER`, `CSV_ROW_CHUNKS`, `FTS_*`, `RRF_*`; see `src/rag/store.mjs`),
ingests the corpus into `data/lancedb-exp/<variant>` and searches every
retrieval case at k = 1, 3, 4, 5, 7, 10. `--best` then merges the per-axis
winners into `BEST` and runs it. Output per directory: `variants.json`,
`turns-<v>.jsonl` (per query: ranks, hits, timings), `variant-<v>.json`
(aggregate, index size, model size, ingest and embed statistics),
`compare.md` and `compare.html` (recall@k, precision@k, hit@k, MRR, paired
up/down counts with a sign test, slices by query source and gold file type,
four canary queries, every query whose recall@3 moved, and a decision block
that names the smallest configuration within noise of the best). No model
other than the embedder runs. `embed-batch.mjs` answers the [I.2.1] question
for the embed path: wall, texts/s and tok/s of sequential awaits, one array
call and N concurrent calls, whether the array result keeps the input order,
and whether one in-flight request can be cancelled by `requestId` without
touching the others.

The second grid, `exp/history-variants.json` over `exp/cases-history`
(built by `exp/build-history-cases.mjs` from `cases/multiquery.jsonl`: one
case per turn with gold, `history` = the earlier user questions of the
session, tags `kind:followup|standalone`, `turn:N`), varies how the search
text is built from the dialogue without a model: `QUERY_HISTORY_TURNS` (user
questions in the search text, current included), `QUERY_HISTORY_CHARS`,
`QUERY_HISTORY_MODE` (concat, vector, fts, fuse), `QUERY_HISTORY_ORDER` and
`QUERY_HISTORY_WHEN` (always, elliptical by the rules of
`src/rag/query-history.mjs`, oracle = the case label, eval-only ceiling).
Variants marked `eval_only` are excluded from the recommendation. Indexes
live under `data/lancedb-exp/<variants file>/<variant>`, one tree per grid,
and the worker runs `ingest()` every time so an index left by another
recipe is rebuilt rather than searched with the wrong vectors.

### Variants (ADR-012)

`--variant <name>` starts `serve` with the environment listed under
`variants.<name>` in `config.json` and names the results directory
`<ts>-<name>`; `header.json` carries `variant` and `serverEnv`. Shipped
names: `baseline` (defaults), `tool-retrieval` (`MERIDIAN_RETRIEVAL_MODE=tool`),
`rewrite` (`MERIDIAN_QUERY_REWRITE=1`), `cosine` and `bm25` (`MERIDIAN_FUSION`),
`shipped-0920` (the layout before 2026-09-21: `MERIDIAN_CONTEXT_LAYOUT=all`,
`MERIDIAN_CHAT_TOPK=3`, `QUERY_HISTORY_TURNS=1`), `context-all-k5` (the old
layout with today's k and search text) and `budget-8k` / `budget-5k`
(`MERIDIAN_CONTEXT_BUDGET`: keep the excerpts in the cached prefix until the
context crosses the budget, then compact). Every multiquery turn row then
also has `retrieval_mode`, `fusion`, `layout`, `compacted` (this turn dropped
the KV cache and replayed the conversation without the earlier excerpts),
`search_query` (the joined text when the history was used),
`fresh_excerpts` (chunks put in front of the model for the first time on this
turn, automatic or through `search_documents`), `search_calls` and `rewrite`
(`to`, `used`, `ms`, `tokens`). `metrics.multiquery.tokens` sums them up:
prompt / prefill / cached / completion / rewrite tokens per turn, total and
prefill tokens per session, turns with fresh excerpts, `search_documents`
calls per turn. In `tool` mode `recall@3` counts the hits of the turn itself
(the first turn's search or the tool's results), so a turn the model answers
from earlier excerpts scores 0 there and still counts under evidence in
context; compare the two together.

`compare.mjs` takes two or more results directories, the first being the
reference, and writes tokens, retrieval, behaviour and latency tables with a
Δ column (relative for tokens and times, percentage points for rates), per
session totals, tokens by turn position and the list of turns whose recall
differs between the runs. It reads files only; no model runs.

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
| retrieval | `query`, `gold_doc_ids` | no model call: one `search(query, k)` per k = 1, 3, 4, 5, 7, 10, scored at its own depth; k counts chunks as the chat feeds them. 133 English cases: 12 written first, 73 multiquery turns with gold (tag `source:multiquery-NN#turn`; follow-ups reworded by hand into standalone queries, tag `followup:resolved`, e.g. "And P2?" → "What is the enterprise P2 first-response SLA?") and 48 hand-written for coverage (tag `source:handwritten-2026-09-20`, `style:question` \| `keyword` \| `paraphrase`); every text file of the corpus is gold at least 4 times |
| single | `query`, `gold_doc_ids`, `reference`, `must` | full path through `serve`; the judge sees `reference` |
| abstain | `query`, `kind`: `out_of_corpus` \| `future` \| `near_miss`, `note` | the right answer is a refusal; `near_miss` names something one step from a real fact (P4 next to P1–P3, ServoDrive X5 next to X4) |
| tools | `messages` (history ending with the user query), `tool` (`lookup_stock` \| `list_documents` \| `null`), `args` (only the arguments that matter, or `null`), `must` | sent without a session, so `messages` is the whole context; `args` is matched as a subset of the call's arguments |
| memory | `turns` (each `query`, optional `must`, optional `tool`), `fact_turn`, `recall_turns` | one live session of about ten turns; the fact appears on `fact_turn` (a tool result or a document), `recall_turns` ask for it again in other words and each carries `must` |
| multiturn | `turns` (each `query`, optional `must`, `tool`, `args`, `gold_doc_ids`, `reference`, `followup`), `consistency` (pairs of 1-based turn numbers about the same fact) | one live session; `followup: true` marks an elliptical turn ("and the warranty?") |
| multiquery | `turns` (each `query`, `gold_doc_ids` of 1–3 files or `[]`, optional `followup`), `runs: 1` | one live session of 5–15 questions; retrieval is scored per turn from `trace.hits`, the `search(query, 3)` the model saw (recall@3, precision@3, MRR, evidence in context = gold retrieved now or shown earlier), split follow-up vs standalone; `gold_doc_ids: []` means the corpus has no answer and a refusal is right; the judge grades every turn with the session's accumulated excerpts, no `reference`, no `must` |
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
{"id":"multiquery-01","runs":1,"turns":[{"query":"What is the standard warranty on the ServoDrive X4?","gold_doc_ids":["policies/warranty-terms.md"]},{"query":"And how long does the extended warranty run?","followup":true,"gold_doc_ids":["policies/warranty-terms.md"]},{"query":"What service credit do we owe for a missed P1?","gold_doc_ids":[]}]}
{"id":"stress-01","queries":["What is the P1 SLA?","How many X4 are in stock in EMEA?"]}
```

## Judge

`lib/judge/` loads the model named in `config.json` (default Qwen3.5-9B
Q4_K_M, a different and larger model than the one under test) after
`serve` has stopped, and asks for a structured verdict per `single` answer
through the SDK's `responseFormat: json_schema`. Claims are checked against
the excerpts and tool results the model was shown; `evidence` quotes are
verified by code as substrings. Enable more categories with
`judgeCategories` in `config.json` (`single` and `multiquery` today).
`npm run eval -- --judge-only results/<ts>` grades a finished run again
without touching `serve`.

For `multiquery` the unit is one turn and the context is **accumulated**:
every excerpt and tool result the session showed the assistant up to that
turn, plus the earlier questions so a follow-up such as "and P2?" can be
resolved. Without that a fact from a chunk three turns back would read as
`not_in_context`. When the accumulated excerpts would not fit the judge's
context the oldest blocks are dropped first and the verdict carries
`context_trimmed`; `judge.ctx` is 16384 for that reason. There is no
reference answer, so the verdict has `claims`, `answered` and `relevance`
but no `correct`; the report splits the turns with gold (faithfulness,
hallucination) from the turns that expect a refusal (judge `refused`). A
claim that only says the documents lack something is a refusal, not a fact,
and is left out of faithfulness and hallucination (`n_meta_claims` counts
them): the local judge listed such sentences as `not_in_context` and turned
every honest refusal into a hallucination. Measured 2026-09-18 on the 91-turn
run: about 30 s per verdict with the accumulated context, 2 of 91 verdicts
truncated at `predict` 700, hence 900.

### Backends

`--judge-backend local` (default) is the model above. `--judge-backend
claude-cli` runs `claude -p --model haiku --json-schema` through the Claude
Code CLI on this machine, with the project's MCP servers and tools switched
off, about 11 s and $0.01 per verdict, four in parallel. **Everything in the
prompt, corpus excerpts included, goes to Anthropic**, which the product's
non-negotiables forbid; the harness allows it only on this explicit flag,
`judge.backend` in `config.json` must stay `local`, and `header.json`
records the backend of every run.

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
misapplied. Multi-turn categories add `turn`. Below a kappa of 0.6 the
prompt in `lib/judge/prompts/` is the thing to fix.

## Definitions

See `docs/todo.md` for the metric definitions and the measurement plan
this harness implements; `lib/metrics/*.mjs` carry the same definitions
next to the code.
