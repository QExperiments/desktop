# Requirements checklist

Source: `context/qvac-challenge-requirements.md`. State verified against
branch `N-8-wire-corpus-ingest` at commit `449b35b` on 2026-09-17, which sits
on `origin/develop` `7f4f5f0` (PR #22, the M-3 ingestion and RAG work) and adds
the corpus path, the open chat route, streaming, tools, the bundle and the
session KV cache.

`[x]` shipped and exercised by a test or a live check · `[~]` partially there,
the gap is named · `[ ]` not started.

Six mandatory blocks, then the optional improvements, then the deliverables
that are not code.

---

## Req #1 — Their data cannot leave their hardware

- [x] **1.1** Inference, embeddings and retrieval on-device or on a
  Meridian-controlled peer, no cloud AI APIs.
  *`serve` opens no outbound connection; retrieval, embeddings and the stock
  tool all run in-process. `src/rag/` imports the SDK directly, against D3 —
  see the note under Req #2.*
- [x] **1.2** Model discovery and download from at least two sources.
  *Three: `--source registry` (QVAC registry), `--source https` (HuggingFace
  mirror, resumable), `--source fs --from-dir` (MDM-provisioned directory).
  `pear://` is available in the SDK but unused — see the note under Req #6.2.
  Weights are fetched at setup time, never bundled. `npm run models:list
  [--refresh]` and `GET /v1/models/catalog` show every role and tier with
  provisioned / in-registry / fits-budget status; the server never downloads.*
- [x] **1.3** Lifecycle `loadModel` → inference → `unloadModel` → `close`.
  *`src/runtime/index.js`; e2e test `loads the resident models and reports the
  tier it serves`.*
- [x] **1.4** Cancellation of in-flight loads and inferences by `requestId`.
  *`src/runtime/cancel.js`, `POST /v1/cancel/:requestId`; unit test
  `cancel.test.js` plus e2e `cancels an inference by requestId and stays usable
  afterwards`. Cancelled downloads keep the partial file and resume.*

**Block status: complete.**

---

## Req #2 — Showing a wrong number to a customer is unacceptable

- [x] **2.1** Ingest `corpus.zip` as given.
  *`unzip corpus.zip -d data/` then `npm run corpus:ingest`, which now calls
  `ingest()` from `src/rag/ingest.mjs`. Against the shipped zip: 32 files found,
  30 indexed (the two `pictures/` are for the VLM path), 34 chunks; a second run
  skips all 30 by content hash. Two SDK findings on the way: `splitStrategy:
  'sentence'` never splits, so `'token'` is the default now, and `chunkSize` is
  in tokens, so 512 keeps three chunks inside the chat context.*
- [x] **2.2** RAG over the private corpus with QVAC embeddings, answers carry
  citations to the source document.
  *`src/chat/answer.js`: every query runs `search()`, the top three chunks
  open the user turn as "Document excerpts" under a fixed system prompt
  (ADR-011), `citations` carries `{ file, score }` and, for a chunk already in
  the session's context, `reused: true`. Verified live against the corpus:
  ServoDrive X4 list price $48,500, P2 SLA 8 hours, P1 SLA 4 hours, each with
  the right files cited; a question the corpus cannot answer gets "not
  mentioned in the provided context". `evals/` now measures retrieval
  (recall@k, MRR) and grounding on every run; `grounded` in the API response
  still means "retrieval returned something".*
- [x] **2.3** Persist embeddings to a local vector store, schema matched to the
  embedding model's dimensionality.
  *LanceDB in `src/rag/store.mjs`, table `meridian_corpus` under `data/lancedb`.
  Rows are `{ id, vector, text, ...metadata }` built through `ragChunk()` and
  `embed()`, so the vector width comes from the embedding model itself rather
  than a hard-coded number. Search is hybrid: cosine plus a full-text index,
  the two rankings fused; `MERIDIAN_FUSION=cosine|bm25` keeps one leg for the
  eval's A/B (ADR-012), the default stays `rrf`.*
- [x] **2.4** Streaming generation.
  *`stream: true` on `/v1/chat/completions` returns OpenAI SSE: a role chunk,
  one chunk per token, a final chunk with `citations` and `grounded`, then
  `[DONE]`. `answer()` forwards `contentDelta` events through an `onDelta`
  callback; the voice loop is unchanged. Verified live, reassembled text equals
  the non-streaming answer.*

**Block status: complete. Test debt named under 2.2.**

### Two things M-3 broke on the way in

- **The SDK boundary.** `ARCHITECTURE.md` D3 and `README.md:160` both state that
  `src/runtime/` is the only module that imports `@qvac/sdk`. All three new
  files — `rag/ingest.mjs`, `rag/retrieve.mjs`, `rag/store.mjs` — import it
  directly. Consequences, not style: retrieval never enters the cancel registry,
  so req 1.4 no longer covers it; and it ignores the tier and delegation logic
  in `src/runtime/`.
- **A second embedding model in memory.** `retrieve.mjs` calls `loadModel()`
  itself and caches its own `modelId`, while the runtime already holds `embed`
  as a resident role. With `serve` running, EmbeddingGemma is loaded twice —
  2 × 328 MB. On the 8 GB fleet laptop from constraint C4 that is the exact
  failure this project is supposed to avoid. `ingest.mjs` also calls `close()`,
  which tears down the shared Bare worker; that is fine for `npm run
  corpus:ingest` as its own process and rules out calling it from the server.
  Both still stand after N-8.

---

## Req #3 — The assistant has to do things aside from chat

- [x] **3.1** Tool-capable model, tools declared with Zod schemas in the `tools`
  array on `completion()`, agent loop driven by structured tool-call events.
  *`src/chat/tools.js` declares both tools with Zod; `answer()` runs the loop
  from `toolCall` events and `final.toolCalls`, appends results as `tool`
  messages, at most three rounds. Two findings recorded in ADR-009: the
  llamacpp plugin only renders tools when the model is loaded with
  `modelConfig.tools: true`, and tier S (Qwen3-0.6B) never calls a tool once
  retrieved context is present, while tier M (Qwen3.5-2B, the D7 default for
  the 2019 laptop) calls the right tool with the right SKU in 6 of 6 probes,
  English and Russian. Unit tests in `tools.test.js`.*
  - [x] **3.1.1** `list_documents` — returns the current corpus inventory.
    *Reads the index; live answer on tier M lists all 30 files by folder.*
  - [x] **3.1.2** Stock lookup tool from the provided `stock-tool.zip`.
    *Vendored as shipped in `vendor/stock-tool`, `verify.mjs` passes 84 checks.
    Live on tier M: 14 units in EMEA, 6 in APAC, "no record" for an unknown
    SKU, cited as `{ file: "stock-tool", asOf: "2026-06-30" }`.*

**Block status: complete from tier M up; tier S answers from the corpus only
and says so.**

---

## Req #4 — Field engineers, hands busy, several languages

- [x] **4.1** Multilingual ASR through QVAC transcription engines, more than one
  input language.
  *whispercpp with language auto-detection, one instance covers every language.
  e2e test transcribes several languages without being told which.
  whisper-tiny on tier S, whisper-base on M, whisper-small on L.*
  - [x] **4.1.1** One-shot `transcribe()`.
    *`POST /v1/audio/transcriptions`; verified live, 0.29 s on tier S.*
  - [x] **4.1.2** Real-time `transcribeStream()`.
    *Needed a 0.9 MB Silero VAD model as a companion — whisper will not segment
    a live stream without it. e2e test `transcribes a live stream chunk by
    chunk`.*
- [x] **4.2** Hands-free loop: spoken question → **grounded** answer → TTS.
  *`POST /v1/audio/ask` closes the loop end to end in ~1.1 s on tier S: audio
  in, text and audio out. It goes through `src/chat/answer.js`, the same seam
  the chat route uses, so with the corpus ingested its answers are grounded and
  cited without a change to the audio routes. The seam is verified live; the
  audio route itself was not re-run after N-8.*
- [x] **4.3** Image + text in one VLM context.
  *`POST /v1/images/ask`. The e2e test sends two generated PNGs and asserts the
  answers differ (`Green.` vs `Blue`), which is what proves the model looks at
  the image instead of guessing from the prompt.*

**Block status: complete.**

---

## Req #5 — The field laptop can be weak

- [x] **5.1** P2P delegated inference to a Meridian-controlled peer addressed by
  public key.
  *`src/p2p/provider.js` + `npm run provide` on the strong machine;
  `loadModel({ delegate: { providerPublicKey } })` on the consumer, configured
  through `QVAC_PROVIDER_PUBLIC_KEY`. Chat, ASR and TTS all delegate. Unit test
  `peer.test.js`.*
  - [x] **5.1.1** Fallback to local inference when the peer is unavailable.
    *Two layers. `waitForPeer` heartbeats the provider first and simply does not
    delegate if it never answers — unit test `retries and then falls back to
    local when the peer never answers`. Below that, the SDK's own
    `fallbackToLocal` is passed only when the delegated tier equals the local
    one, since a model the laptop cannot host has nothing to fall back to.
    Delegated roles are chat, ASR and TTS; embeddings and vision stay local.*
- [x] **5.2** Model and quantization selection at runtime from device
  capability.
  *`src/runtime/capability.js` — total RAM minus a 3.5 GiB OS reserve picks a
  tier, and the tier picks both model and quantization from `models.json`.
  `MERIDIAN_TIER` forces one. `serve` falls back to the largest tier whose
  weights are all present. ADR-003 records why total RAM and not free RAM.*

**Block status: complete.**

---

## Req #6 — They already have a chat tool, and the IT lead can break the deal

- [x] **6.1** OpenAI-compatible HTTP API usable by a stock client without code
  changes.
  *`GET /v1/models` (503 while loading, 200 when ready), `POST
  /v1/chat/completions` with and without `stream`, `/v1/audio/{speech,
  transcriptions,ask}`, `/v1/images/ask`, `POST /v1/cancel/:requestId`. Every
  check below was made with plain `curl` and an OpenAI-shaped body.*
  - [x] **6.1.1** `POST /v1/chat/completions` must run retrieval, grounding and
    tools. A pass-through does not satisfy this.
    *The 501 and `MERIDIAN_UNGROUNDED` are gone (ADR-008 supersedes ADR-004).
    The route always runs `answer()`: retrieval, grounding, the tool loop,
    earlier turns from the client's `messages`. Verified live on tiers S and M.*
  - [x] **6.1.2** Machine-readable `citations` array on the response message.
    *`{ file, score }` per retrieved chunk, `{ file: "stock-tool", asOf }` for
    tool facts. Stored paths checked against the index: `emails/001-...md`,
    `policies/escalation-matrix.txt` — relative to the corpus root as shipped.*
  - [x] **6.1.3** Honour `temperature` and `seed`.
    *Both mapped onto `generationParams`. Verified live: two runs at
    `seed: 42, temperature: 0` returned identical text word for word.*
  - [x] **6.1.4** Declare how to run everything in `qvac-eval.json` at the repo
    root.
    *All nine required fields present, port 11434, `readyPath` `/models`,
    600 s timeout, model ids `meridian-assistant` and `meridian-embed`, `start`
    needs no network, and `setup` now performs the ingest it declares. One
    assumption: the harness unpacks `corpus.zip` into `data/` before `setup`,
    as the README instructs; the script fails with that instruction otherwise.*
- [x] **6.2** Lean, plugin-scoped bundle instead of building against the full
  SDK.
  - [x] **6.2.1** Only the plugins actually used, via `plugins` in
    `qvac.config.*`.
    *Four declared in `qvac.config.json`: llamacpp-completion,
    llamacpp-embedding, whispercpp-transcription, tts-ggml.*
  - [x] **6.2.2** Produce a tree-shaken build.
    *`npm run build` runs the SDK's `bundleSdk` on `qvac.config.json` for the
    worker bundle and esbuild for our code; `npm run build:full` adds the
    all-plugin variant and writes `docs-final/bundle-size.md`. Measured: worker bundle
    11.7 → 9.6 MB, native addons 4811 → 1654 MB across all hosts and 71.5 MB for
    one host, application code 1.1 MB. The app bundle is measured, not what
    `npm run serve` runs: `src/config.js` resolves paths from its own location.*
- [x] **6.3** Reuse the KV cache across turns with a per-session key.
  *Session from the OpenAI `user` field or `x-session-id`, passed as `kvCache`.
  The system prompt is fixed and the excerpts ride in the user turn, so one
  session has one cache file and every turn hits it (ADR-011); the session
  store replays the messages exactly as the model saw them. Measured on tier
  M: turn two processed 15 prompt tokens against 1776 from the cache, first
  token after 45 ms instead of 935 ms; a four-turn session left one file.
  Every answer returns `usage` with `cached_tokens`. Files of sessions past
  the newest five are deleted when a new session starts.*

**Block status: complete. Open question: running from the bundle.**

---

## Improvements — optional, and only after the mandatory batch

Grading principle from §7: *finishing beats expanding*. None of these should
start before the quality debt under "Where this stands" is paid.

- [ ] **I.1** Resilience over P2P
  - [ ] **I.1.1** Provider firewall — allow/deny by consumer public key
  - [ ] **I.1.2** Heartbeat-based provider health checks
  - [ ] **I.1.3** Graceful failover when a provider restarts or drops mid-session
- [ ] **I.2** Simultaneous completion runs via continuous batching, merged event
  stream, per-prompt cancellation
  - [ ] **I.2.1** Report batch-level throughput versus sequential completions
    — embed path measured 2026-09-20 (`evals/embed-batch.mjs`, `evals/results/embed-batch-2026-09-20/report.md`): one array `embed()` is ×6 faster than sequential calls on 133 short queries (×1.7 on CPU), ×1.1 on 34 long chunks; concurrent single calls are rejected by the engine (one job at a time); `cancel({ requestId })` stops an array request in ~12 ms. `batchCompletion` for the LLM still to measure.
- [ ] **I.3** TurboQuant KV-cache quantization at `loadModel`, combined with the
  session `kvCache` path; note the backend in the report
- [ ] **I.4** Drive one capability through the native C++ addon directly,
  bypassing the JS SDK; document the trade-offs
- [ ] **I.5** LoRA fine-tuning on a small domain sample, applied in-product
- [ ] **I.6** Export profiler metrics and include a short performance analysis
  *Closest to free: the SDK profiler already works —
  `profiler.enable({ mode: 'verbose', includeServerBreakdown: true })` then
  `profiler.exportJSON()`. A local run produced 42 phase metrics, e.g. loadModel
  722 ms of which 353 ms is sha256 validation, and completionStream 78.3 ms of
  which 67 ms is model execution. Needs wiring into the product plus prose, not
  invention.*

---

## Deliverables — not code, and separately assessed

### Technical

- [x] Source code in a repository with a README that gets a reviewer from clone
  to running against the provided corpus
  *Quick start is clone → `npm ci` → `models:fetch` → `unzip corpus.zip -d
  data/` → `corpus:ingest` → `serve` → `curl`, and each step was run.*
- [~] Technical and architectural documentation with diagrams: model lifecycle,
  data flow, P2P delegation topology
  *`ARCHITECTURE.md` and `docs-final/decisions.md` cover the decisions in prose. The
  three named diagrams do not exist as committed artifacts.*
- [x] Bundle size report: full-SDK build versus plugin-scoped build
  *`docs-final/bundle-size.md`, regenerated by `npm run build:full`.*
- [ ] Honest overview of AI-assisted coding tools used and how they contributed

### Client-facing

- [ ] One-page executive summary for Dana Whitfield (COO, non-technical): time
  saved, risk avoided, running cost
- [ ] Project plan: phases, milestones, dependencies, risks and mitigations,
  next steps if Meridian says yes
- [ ] Direct answers for Raj Menon (Head of IT & Security): what leaves the
  device and when, what the P2P path exposes, model provenance, what persists
  locally, how they are protected against small-model failure modes
  *Raw material exists: the "What is written to disk" table in the README, the
  provenance manifest with source and sha256 per file, and ADR-002 on why
  `serve` opens no connection. Not written up for Raj.*
- [ ] Proposal / pitch, max 10 slides or 5 pages: problem, deliverable, why
  local-first rather than a compliance workaround, scope in and out, phasing,
  risks
- [ ] Demo video, max 15 minutes, presented as if to Meridian

### Team and plan

- [ ] Team sheet: who worked on what, role, seniority, rough effort
- [ ] How the real engagement would be staffed: roles, headcount, duration,
  client-facing lead
- [~] Relevant assumptions and discovery questions
  *`ARCHITECTURE.md` lists assumptions and questions for Tether, Raj and Dana.
  Not collected into a standalone artifact.*

---

## Where this stands

| Block | Items | Done | Partial | Open |
|---|---|---|---|---|
| Req #1 — on-device | 4 | 4 | 0 | 0 |
| Req #2 — RAG and citations | 4 | 4 | 0 | 0 |
| Req #3 — tools | 3 | 3 | 0 | 0 |
| Req #4 — voice and vision | 5 | 5 | 0 | 0 |
| Req #5 — weak laptop | 3 | 3 | 0 | 0 |
| Req #6 — API and footprint | 9 | 9 | 0 | 0 |
| **Mandatory total** | **28** | **28** | **0** | **0** |

Every mandatory item is shipped and was exercised by a test or a live check.
What remains is quality debt the checks exposed, then the deliverables that
are not code.

**Quality debt, in the order it matters:**

1. **Tier S has no tools.** The 8 GB floor answers from the corpus and says
   when it cannot; stock questions need tier M. Either accept and state it to
   Meridian, or find a layout that works for Qwen3-0.6B (six were tried).
2. **`src/rag/` still imports the SDK directly** for the CLI ingest; the
   server's search now borrows the runtime's embedder, so the second
   EmbeddingGemma copy is gone. Cancel registry coverage of retrieval remains.
3. **Retrieval is measured, not unit-tested.** `evals/cases/retrieval.jsonl`
   and `npm run eval -- --only retrieval` give recall@k and MRR per run; a
   threshold in CI is still open.
4. **Qwen3.5-2B needs its thinking to route tools** (see `models.json`,
   chat role note): with thinking off it answers "you should call
   lookup_stock" instead of calling it; with thinking on a turn costs 4–10 s
   and once 47 s. `reasoning_budget` only works as 0 in this addon and
   `predict` does not cap the scratchpad.
5. **`grounded` means "retrieval returned something"**, not "the answer is
   supported". A score threshold would make it honest.
6. **The app bundle is measured, not run.** `npm run serve` still starts from
   source; running from `dist/` needs path resolution that does not depend on
   the file's location.

**Not code:** the executive summary, Raj's answers, the project plan, the
pitch, the demo video, the team sheet, the AI-tools overview, and the three
diagrams. Raw material for Raj and the assumptions list already exists in
`ARCHITECTURE.md`, the README's disk table and the ADRs.
