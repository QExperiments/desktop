# Decision record

One entry per decision that would be expensive to reverse. Newest last.
Format: context, decision, consequences.

## ADR-001 — Pin `@qvac/sdk` at 0.18.2

**Context.** Req 5.1 names `startQVACProvider()` and
`loadModel({ delegate })`. Those were removed in `@qvac/sdk` 0.19.0
(2026-09-07); 0.18.2 (2026-08-26) is the last release that has them.
`assessModelFit` exists only from 0.19.

**Decision.** Pin 0.18.2 and keep every SDK call inside `src/runtime/`.
Raise the version question with Tether at kickoff.

**Consequences.** P2P delegation is implementable as written. Tier fit is
computed by us from `getSystemResources()` instead of `assessModelFit`.
If Tether confirms a 0.19 replacement, only `src/runtime/` changes.

## ADR-002 — Three model sources, one manifest, no network in `serve`

**Context.** Req 1.2 asks for two or more sources. Req 1.1 and the eval
protocol require `start` to work with outbound traffic blocked.

**Decision.** `npm run models:fetch --source registry|https|fs` provisions
weights from the QVAC registry, the upstream HuggingFace URL, or a
directory the MDM pipeline placed on the machine. Each fetch records role,
tier, source, resolved path, size and sha256 in
`data/models/manifest.json`. `serve` reads only that manifest, checks every
file is present at the recorded size, and refuses to start otherwise.

**Consequences.** A missing weight is a clear error naming `models:fetch`,
never a download during the scored run. The manifest is also the honest
answer to "where did this model come from", which Raj will ask.

## ADR-003 — Tier from total RAM minus a fixed OS reserve

**Context.** Req 5.2 wants model and quantization chosen from device
capability. Free RAM is the obvious input and the wrong one: macOS counts
cached pages as used, so a 24 GB machine reports under 1 GB free.

**Decision.** Budget is total RAM minus `osReserveBytes` (3.5 GiB) from
`models.json`. Tier S below 4 GiB of budget, M from 4 GiB, L from 10 GiB.
`MERIDIAN_TIER` overrides it. The GPU backend is read from the driver
flags and logged, but does not move the tier: integrated graphics borrow
the same system RAM.

**Consequences.** The 8 GB fleet laptop lands on M, which is what the
model sizes were chosen against. Selection is a pure function of a
resources object, so it is unit tested against fixtures rather than
against whatever machine CI runs on.

## ADR-004 — `POST /v1/chat/completions` answers 501 until retrieval lands

**Context.** Req 6.1.1 says the route must run retrieval, grounding and
tools, and that a pass-through to the underlying model does not satisfy
it. The model is already loaded in this stage, so wiring a proxy would
take minutes.

**Decision.** Return 501 in the OpenAI error shape until the retrieval
stage fills the route in. `src/http/` may import the runtime interface but
never `@qvac/sdk`.

**Consequences.** No temporary proxy can quietly survive to submission.
The eval harness fails this route until Stage 2, which is accurate.

## ADR-005 — Weights stay in the SDK cache, not in the repo tree

**Context.** `@qvac/sdk` 0.18.2 caches downloads in `~/.qvac/models` and
only accepts an absolute `cacheDirectory`, which cannot be committed.

**Decision.** Leave the cache at the SDK default and record the resolved
absolute path per weight in our manifest. Files fetched over HTTPS live in
`data/models/https/`, which is git-ignored.

**Consequences.** One machine downloads each weight once for every
checkout. `data/` holds only the manifest, our HTTPS downloads, the PID
file and, from Stage 2, the index.

## ADR-006 — Speech and vision load on demand and unload when idle

**Context.** Req #4 adds transcription, speech and a vision model to a
machine that already holds a chat model and embeddings in 8 GB of RAM.

**Decision.** Chat and embeddings are resident. ASR, TTS, VAD and the
vision model are refcounted, loaded on the first request that needs them
and unloaded five minutes after the last one
(`MERIDIAN_IDLE_UNLOAD_MS`). Loads stay serialized, so two large models
never decode at once. A role can name companion models by config key,
which is how the VLM gets its projection file and Whisper gets the VAD
model a live stream needs.

**Consequences.** The first voice request pays a load; the rest do not.
Peak memory is the resident pair plus one on-demand model, not all of
them. The e2e suite asserts the memory comes back.

**Addendum (N-11, 2026-09-18): the resident pair unloads too.** Chat and
embeddings now give their memory back after an hour without a request
(`MERIDIAN_RESIDENT_IDLE_MS`, 0 keeps them) and load again on the next one;
`/health` lists them under `unloaded` meanwhile. Measured on tier M: the
reload plus the turn took 7.2 s against 3.1 s warm. The session KV files are
dropped with the model: reloaded, the SDK loaded a session's file and then
prefilled the whole history on top of it (2385 prompt tokens instead of 626,
context 6.9k instead of 3.2k), so a fresh file from the stored turns is the
cheaper and bounded path. The idle clock starts at boot.

## ADR-007 — The voice loop goes through the same answer seam as chat

**Context.** Req 4.2 wants a hands-free loop that returns a grounded
answer. Grounding is not built yet, and a second answer path would mean
retrofitting retrieval in two places later.

**Decision.** `src/chat/answer.js` is the only place a question becomes
an answer. It already returns `{ text, citations }`, with citations empty
until the retrieval stage fills it. The model's `<think>` block is
captured separately so reasoning is never spoken or shown.

**Consequences.** Voice answers are currently ungrounded, and the README
says so. When retrieval lands, the loop becomes grounded without a change
to the audio routes.

## ADR-008 — `POST /v1/chat/completions` is open; ADR-004 is superseded

**Context.** ADR-004 returned 501 so that a pass-through without retrieval
could not survive to submission. Retrieval now exists behind
`src/chat/answer.js` (M-3), and `npm run corpus:ingest` fills the index
(N-8). The condition ADR-004 guarded against no longer holds.

**Decision.** Drop the 501 and the `MERIDIAN_UNGROUNDED` flag. The route
always goes through `answer()`, which retrieves, grounds and cites.
`grounded` on the response is `true` only when retrieval returned chunks,
so an empty index still cannot pass as a grounded answer.
The chat model loads with `ctx_size: 4096` (SDK default 1024) and the
corpus is chunked at 512 tokens, so three retrieved chunks plus the answer
fit; the first live call overflowed 1024 with whole-document chunks.

**Consequences.** The eval harness can score the route. `stream: true`
answers OpenAI SSE chunks, citations and `grounded` on the last one (req
2.4). Tools are not yet in the loop (req 3); until they are, 6.1.1 is met
for retrieval and grounding only.

## ADR-009 — Tools ride next to the retrieved context; tier S is chat-only

**Context.** Req 3 wants `list_documents` and the shipped stock tool
behind Zod schemas, driven by structured tool-call events. Two findings
while wiring it. First, the llamacpp plugin only renders tools into the
prompt when the model is loaded with `modelConfig.tools: true`; without
it the model never sees them and talks *about* the tool instead. Second,
with retrieved context in the prompt, Qwen3-0.6B (tier S) never calls
`lookup_stock` in any of six prompt layouts tried, while Qwen3.5-2B
(tier M) calls the right tool with the right SKU in 6 of 6 questions,
English and Russian, with context in the system prompt. Layouts that
keep the system prompt constant (context in the user turn, or retrieval
as a prior tool call) cost tier M the `list_documents` calls.

**Decision.** Keep the context in the system prompt. The chat role loads
with `tools: true`. `answer()` runs the loop: one completion per round,
tool results appended as `tool` messages, at most three rounds. Tool
facts are cited as `{ file: "stock-tool", asOf }`, as the tool's README
asks. `vendor/stock-tool` is the zip as shipped; `node verify.mjs` there
must keep passing.

**Consequences.** Tools work from tier M up, which is the tier D7 names
for the 2019 laptop. Tier S answers from the corpus and says when it
cannot answer; it does not reach the stock tool. Because the system
prompt changes with every question, the SDK's KV cache (keyed on system
prompt + tools) cannot carry a prefix between questions; req 6.3 has to
live with that or change the layout.

## ADR-010 — KV cache keyed by the client's session, opt-in

**Context.** Req 6.3 asks for KV reuse across turns under a per-session
key. The SDK's `kvCache: "<key>"` stores `{key}/{modelId}/{configHash}.bin`,
where `configHash` covers the system prompt and the tool block, primes
the system prompt once, and on later calls sends only the messages it has
not yet seen under that key. A stock OpenAI client has no session field,
but it does have `user`.

**Decision.** `/v1/chat/completions` takes the session from the request's
`user` field or an `x-session-id` header and passes it as
`meridian-<session>`. Without either, no cache is used. The route also
forwards all of the client's earlier user and assistant turns (N-9 dropped the
six-turn cap; `ctx_size` is the bound) so the model has the conversation with or
without a cache. Rounds of the tool
loop share the key.

**Consequences.** Measured on tier M: within one question the tool loop's
second round reuses the cache and sends one message, 5.0 s against 6.8 s
uncached. Across turns a hit needs the same system prompt, and ADR-009
puts the retrieved context there, so consecutive questions on the same
topic hit and topic changes miss; three turns of one session produced
three cache files. Each file is about 33 MB and nothing deletes them yet.
Two follow-ups, not taken: wipe `meridian-*` caches at server start
(sessions do not outlive the process anyway), and give keyless requests
an ephemeral key deleted after the answer so every request gets the
in-question reuse.

**Addendum (N-11, 2026-09-18): `user` is no longer a session key.** OpenAI
defines `user` as an end-user identifier for abuse monitoring, not a
conversation id. A stock client that sets it and sends its full `messages`
would have fallen into session mode and had its history ignored in favour of
the server's. Only `x-session-id` names a session now, as the chat page and
the voice route already did; without it a request is stateless Chat
Completions. `DELETE /v1/sessions/:id` removes a session and its KV file.

**Addendum (N-9, 2026-09-17): why the context stays in the system prompt.**
The system prompt is rebuilt every turn with the retrieved chunks, and the
SDK names the cache file by session key plus a hash of the system prompt, so
each turn whose retrieval differs opens a new file: one browser chat left
nine 33 MB files. The obvious fix was tried, a fixed system prompt with the
context inside the user turn. It did what the cache wants: one file per
session, turns two and three sent one message each, `REUSING cache` in the
log. It failed on two other counts. Qwen3.5-2B stopped calling
`lookup_stock` when the context sat in the user turn (it reasoned that the
documents hold no stock and answered so), and every turn's context stays in
the reused KV state, so the second turn of a session overflowed `ctx_size`
4096 at 4246 tokens. Per-turn re-prefill is therefore the layout kept:
turns stay bounded and independent, tool routing on tier M holds, and the
cache still pays inside the tool loop. Cross-turn reuse would need a model
that routes tools with context in the user turn plus a context budget of
8k or more; both are tier L questions.

## ADR-011 — Fixed system prompt, excerpts in the user turn, one KV file per session

**Context.** ADR-009 and ADR-010 left the retrieved context in the system
prompt, which the SDK hashes into the cache file name: every turn with a
different retrieval opened a new 33 MB file and re-prefilled the whole
conversation. The N-9 attempt to move the context failed on two counts,
Qwen3.5-2B stopped calling `lookup_stock`, and the session overflowed a
4096-token context on turn two.

**Decision.** The system prompt is fixed and names the tools' duties
explicitly ("the documents never hold stock quantities … call
lookup_stock"). Retrieved excerpts open the user turn; chunks already
shown in the session are not repeated but stay in the citations as
`reused`. A session stores each turn's messages exactly as the model saw
them (excerpts, tool calls, tool results, answer) and replays them under
its id, because the SDK counts stored messages under a custom key and sends
only the tail; the client's own copy of the history is ignored when a
session is given. Contexts grow to 8k on S, 16k on M and 32k on L, which
Qwen3.5's hybrid attention affords (12 KB per token on 0.8B and 2B, 32 KB
on 4B). Tier S moves to Qwen3.5-0.8B and tier L to Qwen3.5-4B so every
tier has tools and shares its weights with the vision role. The cache
files of sessions past the newest five are deleted when a new session
starts.

**Consequences.** Measured on tier M: one cache file for a four-turn
session, turn two processed 15 prompt tokens against 1776 from the cache,
first token after 45 ms instead of 935 ms, a stock lookup on turn three and
a fact from turn one recalled on turn four. Whether tool routing and
recall hold across the case set is what `evals/` measures; the memory and
stress categories exist for this layout. A reopened old session pays one
full prefill. Every answer now returns `usage` and `stats`, and requests
with `x-eval-run` leave a trace under `data/traces/`.


## ADR-012 — Retrieval strategy is a run-time switch, compared by the eval

**Context.** The multiquery run of 2026-09-18 (tier M, 10 sessions, 91
turns) showed where the shipped layout of ADR-011 spends its tokens and
where it misses: every turn runs `search(query, 3)` and puts the fresh
chunks into the user turn, so prompt tokens grow with every question even
when the answer is already in the context, and an elliptical follow-up
("and the extended one?") retrieves at 69% recall against 78% for a
standalone question. Three alternatives were on the table: retrieve once
per session and let the model ask for more through a tool, rewrite the
query into a standalone one before searching, and drop the BM25 leg of the
hybrid search. Each changes tokens and recall in a different direction and
none can be judged without a run against the same case set.

**Decision.** The strategy is chosen by three environment variables read
once at start (`src/config.js`, `config.retrieval`), so one `serve` runs
one strategy and the eval starts one server per variant:

| Variable | Values | What changes |
| --- | --- | --- |
| `MERIDIAN_RETRIEVAL_MODE` | `auto` (default), `tool` | `auto`: search before every turn. `tool`: search before the first turn of a session only; afterwards the model gets a `search_documents(query)` tool and calls it when the excerpts in the conversation do not hold the answer. Excerpts a tool call returns are shown once, like the automatic ones, and count as hits and citations |
| `MERIDIAN_QUERY_REWRITE` | `0` (default), `1` | on a turn with history the chat model first rewrites the query into a standalone search query (no KV key, `predict` 48, thinking off); the rewritten text goes to the search, the original to the model and the user; the rewrite's tokens are added to `usage` and its time to `stats.rewrite_ms` |
| `MERIDIAN_FUSION` | `rrf` (default), `cosine`, `bm25` | `rrf` fuses the cosine and BM25 rankings (k = 60); `cosine` ranks by vector distance only, `bm25` by the full-text index only; `score` is the RRF score, the cosine similarity or the BM25 score respectively |

The eval harness gets `--variant <name>` (`evals/config.json` →
`variants`), writes the variant and the environment into `header.json`,
and `evals/compare.mjs` puts the multiquery metrics of several result
directories side by side: tokens per turn and per session, recall@3 by
turn kind, evidence in context, tool calls, refusals, latency. The
defaults are the shipped behaviour of ADR-011; nothing changes for a user
until a variant wins and the default moves.

**Consequences.** Every variant is one more path through `answer.js` that
the unit tests must cover. The `tool` mode depends on the 2B model calling
a tool it was not trained on our prompt for; the eval measures how often
it does. Query rewriting costs one extra completion per follow-up on the
same model, which also evicts the session's in-memory KV state between
the rewrite and the answer; the cache ratio in the run shows what that
costs. Measured 2026-09-18 on `multiquery` (91 turns, tier M, Qwen3.5-2B,
no judge; `evals/results/compare-retrieval-ab/`): `tool` cuts session tokens
by 34 % but the 2B model calls `search_documents` on 4 % of turns and false
abstentions rise from 9 % to 22 %; rewrite lifts follow-up recall@3 from
69 % to 81 % for about +1.1 s wall per turn and fewer abstentions on
unanswerable turns; `cosine` alone loses 14 pp recall@3; `bm25` alone
matches RRF on English turns and is the only ranking that puts the Q2
report first, but returns nothing for Russian queries. The defaults stay
`auto`, no rewrite, `rrf`; the write-up is in `docs/todo-2.md` under
"Итоги A/B".

## ADR-013 — EmbeddingGemma task prefixes and a heavier BM25 leg are the retrieval defaults

**Context.** The retrieval-only experiment of 2026-09-20 (`docs/todo-3-exp.md`,
`evals/retrieval-exp.mjs`, results in `evals/results/retrieval-exp-2026-09-20/`)
ran 26 variants of the retriever against the 133-query English set
(`evals/cases/retrieval.jsonl`) with no LLM involved: three other embedding
models, five chunkings, four text preparations, RRF and FTS settings, the
merged winners and their ablations. The shipped retriever (B0) scored
recall@3 83 %, MRR 0.908. Two changes carried the gain and were additive:
the task prefixes EmbeddingGemma was trained with (`title: <file> | text:` on
documents, `task: search result | query:` on queries; +3 pp recall@3,
recall@1 50 → 55 %, MRR +0.026, sign test p = 0.031) and a BM25 leg weight
of 1.5 in the reciprocal-rank fusion (+6 pp, 24 queries up / 6 down,
p = 0.001; 1.25 and 2.0 score the same, so the plateau is wide). Together
(A5) they give recall@3 89 %, recall@1 58 %, MRR 0.946 with no slice of
20+ items losing more than 2 pp. The other axes did not pay: Q4_0 equals
Q8_0 (85 vs 83 %, p = 0.15), BF16 does not help, GTE-large at 1024 dims
matches its Gemma control (86 vs 86 %) at twice the size and a 512-token
context that our 512-token chunks overflow; smaller chunks lower recall
(128 tokens: −3 pp, 120 chunks) while raising precision; the file header,
row-per-record chunks, MRL 256 dims, deeper RRF candidates, no stemming and
the ngram tokenizer all lose or tie. Character chunking (+4 pp alone) adds
0.2 pp once the two winners are in.

**Decision.** `src/rag/store.mjs` defaults change on two knobs and nothing
else: `EMBED_PREFIX=gemma` (documents embedded as `title: <file> | text: …`,
queries as `task: search result | query: …`; the stored `text` column and the
BM25 index keep the raw chunk) and `RRF_BM25_WEIGHT=1.5`. Both stay
environment switches, so `EMBED_PREFIX=none RRF_BM25_WEIGHT=1` reproduces
the old retriever. The content hash that lets `corpus:ingest` skip unchanged
files now covers the embedding recipe (model, prefix, dims, chunking), so a
change of any of them re-indexes every file on the next ingest instead of
leaving stale vectors next to queries embedded the new way. The eval's
`K_LIST` gains k = 4. Chunk size, model quantization and fusion depth stay as
they were.

**Consequences.** Every indexed corpus has to be re-ingested once (34 chunks,
3 s on the dev Mac; the recipe hash does it on the next `corpus:ingest`).
The server path is unchanged in shape: `search()` applies the query prefix
before calling the runtime's embedder. Query-time cost is unchanged
(retrieval p50 12 ms). The gain is measured on retrieval alone; the
end-to-end multiquery eval of ADR-012 has to be rerun before the
2026-09-18 numbers are compared with new runs. Q4_0 is a free 50 MB saving
for tier S and is left as a follow-up. The variants file keeps B0 pinned to
the pre-ADR defaults so the experiment stays reproducible.

## ADR-014 — The context carries only the current turn's excerpts; the KV cache buys turns through a budget

**Context.** ADR-011 put the retrieved excerpts inside the user turn and left
them there: turn N's chunks stay in the context for the rest of the session,
which is what makes the KV cache work — the prefix never changes, so a turn
prefills its own tail and nothing else (cache ratio 87 %, TTFT p50 293 ms).
The price is a context that grows with retrieval. Measured on the 83-turn
multiquery suite (2026-09-21, `docs/todo-3-exp.md` «Эксперимент 3»): 619
tokens per turn at k = 3 and 948 at k = 5, so tier M (16k) runs out after 24
turns at k = 3 and 15 at k = 5, tier S (8k) after 11 and 6. One runaway
answer (the `predict` bug, todo-2) then overflows the context and kills the
rest of the session: 7 of 83 turns failed that way in the k = 3 run. It also
lets the model answer from a chunk retrieved five turns ago — 22 % of answers
at k = 3, 39 % at k = 5 — which reads as grounding but is not measured by
this turn's retrieval.

Three layouts were run end to end: excerpts everywhere (all), excerpts only
in the last user turn (current) at k = 3 and k = 5. At equal k the retrieval
is identical (recall@5 91 %, MRR 0.92 in both layouts); what differs is the
context (2364 vs 4830 tokens per turn at k = 3) and the cost of building it.
Layout current cannot reuse the cache as the SDK stands: the state is keyed
by session, records how many messages it covers and is then appended to, so
an earlier message cannot be rewritten or dropped — only the whole file can
go (`kv-cache-session.js`, `deleteKvCacheState`). Undercounting the saved
messages does not help: the addon has already written this turn's excerpts
into the state. So current runs with no key and prefills every turn whole:
TTFT p50 1681 ms at k = 3, 2327 ms at k = 5, wall p50 5.9 s and 7.3 s.

**Decision.** `MERIDIAN_CONTEXT_LAYOUT=current` becomes the default, with
`MERIDIAN_CHAT_TOPK=5` and the query built from the last three questions of
an elliptical follow-up (`QUERY_HISTORY_TURNS=3`, `QUERY_HISTORY_WHEN=
elliptical`, variant E3 of the 2026-09-21 grid). Earlier user turns are
replayed as the bare question, tool calls and tool results are replayed
as they were, and every turn shows its five chunks. `MERIDIAN_CONTEXT_BUDGET`
adds the middle ground: while the estimated context stays under the budget
the excerpts of earlier turns stay in the cached prefix and the KV cache is
reused as before; the turn that would cross it drops the cache file, replays
the conversation clean and re-primes. `src/chat/answer.js` decides this in
`compactionBase()`; the session stores the `base` each turn ran with, and
`sessions.context()` reports the chunk ids per turn so a compaction knows
which are still in front of the model. `MERIDIAN_CONTEXT_LAYOUT=all`
reproduces ADR-011 exactly.

**Consequences.** The context stops growing with retrieval: it holds the
system prompt, the questions and answers so far, and five chunks, whatever
the turn number. A session no longer dies of context overflow, and an
answer can no longer lean on a chunk the user asked about five turns ago.
The cost without a budget is a full prefill per turn, which is latency, not
tokens: total tokens per session fall. With a budget the cost is one prefill
per compaction. The `prompt_tokens` the SDK reports with a cache key are
`cached + prefill` and double-count the first call of a session, so token
tables across layouts are read from `prefill` and the reconstruction in
«Эксперимент 3», not from `prompt_tokens` alone.
