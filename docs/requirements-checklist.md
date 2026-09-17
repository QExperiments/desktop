# Requirements checklist

Source: `context/qvac-challenge-requirements.md`. State verified against
`origin/develop` at commit `7f4f5f0` on 2026-09-17, after PR #22 merged the
M-3 ingestion and RAG work.

`[x]` shipped and exercised by a test or a live check · `[~]` partially there,
the gap is named · `[ ]` not started.

Six mandatory blocks, then the optional improvements, then the deliverables
that are not code.

---

## Req #1 — Their data cannot leave their hardware

- [x] **1.1** Inference, embeddings and retrieval on-device or on a
  Meridian-controlled peer, no cloud AI APIs.
  *Only `src/runtime/` and `src/p2p/` import the SDK; `serve` opens no outbound
  connection. Retrieval itself does not exist yet — see Req #2.*
- [x] **1.2** Model discovery and download from at least two sources.
  *Three: `--source registry` (QVAC registry), `--source https` (HuggingFace
  mirror, resumable), `--source fs --from-dir` (MDM-provisioned directory).
  `pear://` is available in the SDK but unused — see the note under Req #6.2.
  Weights are fetched at setup time, never bundled.*
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

- [~] **2.1** Ingest `corpus.zip` as given.
  *The pipeline exists — `src/rag/ingest.mjs` walks the corpus, parses per file
  type and chunks with `ragChunk()`. **Nothing calls it.** `ingest()` is
  exported and has no caller anywhere in `src/`, `scripts/` or `test/`, while
  `npm run corpus:ingest` still runs the same three-line stub that prints
  "nothing to do" and exits 0. `qvac-eval.json` declares that script in `setup`,
  so the harness would set up an empty store and never notice.*
- [~] **2.2** RAG over the private corpus with QVAC embeddings, answers carry
  citations to the source document.
  *Wired end to end in `src/chat/answer.js`: every question runs `search()`,
  the top 3 chunks go into the system prompt as a context block with an explicit
  "do not invent facts beyond it", and `citations` is filled with
  `{ file, score }`. Retrieval failure degrades to a plain answer instead of
  failing the request. **Never run against a corpus and not covered by a single
  test**, so it is code-complete and unverified.*
- [x] **2.3** Persist embeddings to a local vector store, schema matched to the
  embedding model's dimensionality.
  *LanceDB in `src/rag/store.mjs`, table `meridian_corpus` under `data/lancedb`.
  Rows are `{ id, vector, text, ...metadata }` built through `ragChunk()` and
  `embed()`, so the vector width comes from the embedding model itself rather
  than a hard-coded number. Search is hybrid: cosine plus a full-text index,
  the two rankings fused.*
- [ ] **2.4** Streaming generation.
  *The SDK stream is consumed internally (`run.events`, `contentDelta`), which
  is how the voice loop works. Nothing is streamed to an HTTP client:
  `stream: true` on `/v1/chat/completions` returns 501, and there is no SSE.*

**Block status: the hard part is built, the cheap part is missing. One caller
for `ingest()` turns three partials into a working corpus path.**

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
  failure this project is supposed to avoid. `ingest.mjs` additionally calls
  `close()`, which tears down the shared Bare worker, so it can never be called
  in-process from the server.

---

## Req #3 — The assistant has to do things aside from chat

- [ ] **3.1** Tool-capable model, tools declared with Zod schemas in the `tools`
  array on `completion()`, agent loop driven by structured tool-call events.
  *No `tools` array and no `zod` import anywhere in `src/`. The chat model on
  tier S (Qwen3-0.6B) is also the wrong size for a reliable tool loop; tier M
  is `QWEN3_5_2B_MULTIMODAL_Q4_K_M`, and its tool-call quality is the open
  question recorded in `ARCHITECTURE.md` D7.*
  - [ ] **3.1.1** `list_documents` — returns the current corpus inventory.
    *Depends on 2.1: there is no inventory until the corpus is ingested.*
  - [ ] **3.1.2** Stock lookup tool from the provided `stock-tool.zip`.
    *The zip has not been unpacked into the repo.*

**Block status: not started.**

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
- [~] **4.2** Hands-free loop: spoken question → **grounded** answer → TTS.
  *`POST /v1/audio/ask` closes the loop end to end in ~1.1 s on tier S: audio
  in, text and audio out. Grounding arrived with M-3 — the loop goes through
  `src/chat/answer.js`, which now retrieves and cites. The bet that one seam
  would serve both callers paid off. It stays partial for the same reason as
  2.2: with no corpus ingested, `search()` returns nothing and the loop answers
  ungrounded with an empty `citations`.*
- [x] **4.3** Image + text in one VLM context.
  *`POST /v1/images/ask`. The e2e test sends two generated PNGs and asserts the
  answers differ (`Green.` vs `Blue`), which is what proves the model looks at
  the image instead of guessing from the prompt.*

**Block status: complete except grounding in 4.2, which is Req #2 work.**

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

- [~] **6.1** OpenAI-compatible HTTP API usable by a stock client without code
  changes.
  *`GET /v1/models` (503 while loading, 200 when ready), `POST
  /v1/chat/completions`, `/v1/audio/{speech,transcriptions,ask}`,
  `/v1/images/ask`, `POST /v1/cancel/:requestId`. The surface is there; the main
  route does not yet run the product.*
  - [ ] **6.1.1** `POST /v1/chat/completions` must run retrieval, grounding and
    tools. A pass-through does not satisfy this.
    *Still returns **501 by default**, gated behind `MERIDIAN_UNGROUNDED=1`.
    **The reason recorded in ADR-004 has expired**: it refused because a
    pass-through without retrieval would ship, and retrieval now exists on the
    other side of `answer()`. What is left is a decision plus 2.1 — open the
    route, ingest a corpus, and this is the item that is no longer blocked by
    missing code. ADR-004 needs a successor entry either way.*
  - [~] **6.1.2** Machine-readable `citations` array on the response message.
    *Now populated from retrieval as `{ file, score }`, the exact shape §5.2
    asks for. Unverified: `file` must be relative to the corpus root as shipped
    in `corpus.zip`, and with nothing ingested nobody has checked that the
    stored path matches that form.*
  - [x] **6.1.3** Honour `temperature` and `seed`.
    *Both mapped onto `generationParams`. Verified live: two runs at
    `seed: 42, temperature: 0` returned identical text word for word.*
  - [~] **6.1.4** Declare how to run everything in `qvac-eval.json` at the repo
    root.
    *All nine required fields present, port 11434, `readyPath` `/models`,
    600 s timeout, model ids `meridian-assistant` and `meridian-embed`, and
    `start` needs no network. Downgraded from done: `setup` promises
    `npm run corpus:ingest`, and that script is still the stub. The file now
    declares a step the repository does not perform.*
- [~] **6.2** Lean, plugin-scoped bundle instead of building against the full
  SDK.
  - [x] **6.2.1** Only the plugins actually used, via `plugins` in
    `qvac.config.*`.
    *Four declared in `qvac.config.json`: llamacpp-completion,
    llamacpp-embedding, whispercpp-transcription, tts-ggml.*
  - [ ] **6.2.2** Produce a tree-shaken build.
    *`npm run build` and `npm run build:full` are stubs that exit 1. Nothing is
    built, so there is no bundle-size report either — and that report is a named
    deliverable. For scale: `node_modules/@qvac/` is **4.5 GB** because every
    native addon ships prebuilds for darwin-arm64/x64, linux, win32, android and
    the iOS simulators, while the one binary this machine runs is 12.4 MB.*
- [ ] **6.3** Reuse the KV cache across turns with a per-session key.
  *No `kvCache` or session key anywhere in `src/`. The SDK writes to
  `~/.qvac/kv-cache/` but nothing passes a per-session key, so multi-turn chat
  rebuilds attention state from the whole history every question.*

**Block status: the eval contract and plugin scoping are done; the route that
the whole submission is scored through (6.1.1) is not.**

---

## Improvements — optional, and only after the mandatory batch

Grading principle from §7: *finishing beats expanding*. None of these should
start while Req #2, #3 and 6.1.1/6.2.2/6.3 are open.

- [ ] **I.1** Resilience over P2P
  - [ ] **I.1.1** Provider firewall — allow/deny by consumer public key
  - [ ] **I.1.2** Heartbeat-based provider health checks
  - [ ] **I.1.3** Graceful failover when a provider restarts or drops mid-session
- [ ] **I.2** Simultaneous completion runs via continuous batching, merged event
  stream, per-prompt cancellation
  - [ ] **I.2.1** Report batch-level throughput versus sequential completions
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

- [~] Source code in a repository with a README that gets a reviewer from clone
  to running against the provided corpus
  *README covers clone → fetch → serve → curl and is accurate. "Against the
  provided corpus" is not true yet: there is no corpus path.*
- [~] Technical and architectural documentation with diagrams: model lifecycle,
  data flow, P2P delegation topology
  *`ARCHITECTURE.md` and `docs/decisions.md` cover the decisions in prose. The
  three named diagrams do not exist as committed artifacts.*
- [ ] Bundle size report: full-SDK build versus plugin-scoped build
  *Blocked on 6.2.2 — neither build runs.*
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
| Req #2 — RAG and citations | 4 | 1 | 2 | 1 |
| Req #3 — tools | 3 | 0 | 0 | 3 |
| Req #4 — voice and vision | 5 | 4 | 1 | 0 |
| Req #5 — weak laptop | 3 | 3 | 0 | 0 |
| Req #6 — API and footprint | 9 | 2 | 4 | 3 |
| **Mandatory total** | **28** | **14** | **7** | **7** |

Two blocks are complete (#1, #5). Req #3 is the only one still untouched. The
rest is finishing, not building.

**What is left, in the order that unblocks the most:**

1. **Call `ingest()`.** Replace the stub in `scripts/corpus-ingest.js` with a
   caller and put the corpus in place. This alone moves 2.1, 2.2, 4.2, 6.1.2 and
   6.1.4 from partial to verifiable, because every one of them is waiting on the
   same missing corpus rather than on missing code.
2. **Open `/v1/chat/completions` (6.1.1).** Its stated reason has expired now
   that retrieval exists. Needs the route ungated, a successor to ADR-004, and
   proof that `citations[].file` is relative to the corpus root.
3. **Put `src/rag/` back behind the runtime.** Restores D3, stops loading
   EmbeddingGemma twice, and brings retrieval back under the cancel registry.
4. **Test the RAG path.** Thirty-four tests pass and not one touches `src/rag/`.
   The recall harness in `retrieve.mjs` already has the query set for it.
5. **Tools (3.1).** The only block with nothing written.
6. **Then 6.2.2 and 6.3** — the tree-shaken build with its size report, and the
   per-session KV cache key.
