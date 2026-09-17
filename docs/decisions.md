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

