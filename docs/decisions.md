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
