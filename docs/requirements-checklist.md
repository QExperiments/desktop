# Requirements checklist

Source: `context/qvac-challenge-requirements.md`. State verified against
`origin/develop` at commit `2cf6e4d` on 2026-09-16.

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

- [ ] **2.1** Ingest `corpus.zip` as given.
  *`scripts/corpus-ingest.js` is a three-line stub that exits 0 so the
  `qvac-eval.json` setup chain already runs. No corpus is on disk.*
- [ ] **2.2** RAG over the private corpus with QVAC embeddings, answers carry
  citations to the source document.
  *`runtime.embed()` exists and the embedding model is resident, but nothing
  calls it. `citations` is always `[]`.*
- [ ] **2.3** Persist embeddings to a local vector store, schema matched to the
  embedding model's dimensionality.
  *No store chosen yet. The e2e test already asserts the embedding dimension so
  the schema has something to match.*
- [~] **2.4** Streaming generation.
  *The SDK stream is consumed internally (`run.events`, `contentDelta`), which
  is how the voice loop works. Nothing is streamed to an HTTP client:
  `stream: true` on `/v1/chat/completions` returns 501, and there is no SSE.*

**Block status: not started. This is the critical path — 2.2 and 6.1.1 are the
same work, and the eval harness checks the cited source.**

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
  in, text and audio out. The answer is **not grounded** — retrieval is Req #2.
  The loop already runs through `src/chat/answer.js`, the one seam grounding
  will land in, so both this and `/v1/chat/completions` gain it at once.*
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
    *Returns **501 on purpose** (ADR-004). `MERIDIAN_UNGROUNDED=1` enables an
    ungrounded answer for local testing only; `serve`, `qvac-eval.json` and CI
    never set it. Asked for a ServoDrive X4 lead time with no corpus, the model
    invented "approximately 12 to 14 weeks" — which is exactly why the route
    refuses by default.*
  - [~] **6.1.2** Machine-readable `citations` array on the response message.
    *The array is on the response and always empty. Shape is fixed (`file`
    required, `score` optional, `file` relative to the corpus root); the content
    waits on Req #2.*
  - [x] **6.1.3** Honour `temperature` and `seed`.
    *Both mapped onto `generationParams`. Verified live: two runs at
    `seed: 42, temperature: 0` returned identical text word for word.*
  - [x] **6.1.4** Declare how to run everything in `qvac-eval.json` at the repo
    root.
    *All nine required fields present, port 11434, `readyPath` `/models`,
    600 s timeout, model ids `meridian-assistant` and `meridian-embed`.
    `start` needs no network.*
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

| Block | Done | Partial | Open |
|---|---|---|---|
| Req #1 — on-device | 4 | 0 | 0 |
| Req #2 — RAG and citations | 0 | 1 | 3 |
| Req #3 — tools | 0 | 0 | 3 |
| Req #4 — voice and vision | 4 | 1 | 0 |
| Req #5 — weak laptop | 3 | 0 | 0 |
| Req #6 — API and footprint | 3 | 3 | 3 |
| **Mandatory total** | **14** | **5** | **12** |

Two blocks are complete (#1, #5), one is complete but for grounding (#4), and
three are the remaining work (#2, #3, #6). Req #2 unblocks the most: it turns
4.2 into a grounded loop, fills 6.1.2, and is most of 6.1.1 — which is the one
route the submission is actually scored through.
