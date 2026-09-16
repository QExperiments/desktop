# Stage 1 plan — Architecture + Req #1 (model runtime)

Draft for approval, 2026-09-15. Covers reqs **1.1–1.4** (= issue **N-03 Model Manager** plus the parts of N-01 the runtime cannot run without). Nothing is committed until approved.

## 1. Scope

| In | Out (later stage) |
|---|---|
| Land `ARCHITECTURE.md` and map its stages to the GitHub board | Retrieval, `index.db`, ingest (N-02, M-03, M-04 → Stage 2) |
| ESM skeleton: scripts from `qvac-eval.json`, `qvac.config.json`, `.nvmrc`, `src/` layout, CI | `POST /v1/chat/completions` (N-04 → Stage 2). Stage 1 answers **501**, never a pass-through |
| `models.json` (roles × tiers, draft until M-02 delivers) + tier detection by hardware | Tools, KV-cache, audio, vision, P2P (N-05…N-09) |
| `npm run models:fetch`: registry + HTTPS + filesystem sources, sha256, manifest, cancel, resume | LRU idle-unload of on-demand models (interface only now, policy in Stage 4) |
| `src/runtime/`: load → infer → unload → close, cancel registry by `requestId`, degradation to a lower tier | Bundle report (N-08) |
| `npm run serve` / `serve:stop`: readiness on `GET /v1/models`, `POST /v1/cancel/:id`, PID, SIGTERM | |
| Tests: unit + opt-in e2e smoke (real small models) | Docker offline dry-run (N-10) |
| Docs: README "Models" section, ADR-001…003 | |

## 2. Deliverables

```
qvac-eval.json  qvac.config.json  models.json  .nvmrc  .github/workflows/ci.yml
scripts/models-fetch.mjs
src/
  config.mjs  logger.mjs                 # same names/shape as the N-2 branch to ease the merge
  entry/node.mjs  entry/serve-stop.mjs
  runtime/index.mjs      createRuntime({ sdk, manifest, tier }) → start/stop/acquire/release/cancel
  runtime/capability.mjs getSystemResources → tier S|M|L (+ MERIDIAN_TIER override), reason string
  runtime/models.mjs     role → tier → entry; manifest read; local path or catalog constant
  runtime/memory.mjs     resident set, refcount, serialized loads, fallback to next lower tier
  runtime/cancel.mjs     Map requestId → { kind, role, startedAt }; cancel one / cancel all
  http/server.mjs  http/models.mjs  http/cancel.mjs
test/unit/*.test.mjs  test/e2e/runtime.e2e.mjs
docs/decisions.md  README.md (Models section)  ARCHITECTURE.md (small edits, see §4)
data/  (git-ignored) models/ manifest.json logs/ .serve.pid
```

## 3. Work breakdown

Base: `develop` (= N-1). Two branches so the architecture can be reviewed by the team quickly.

| # | Branch / commit | What | Est. |
|---|---|---|---|
| 1 | `N-3-architecture` → `N-3: Add architecture document` | `ARCHITECTURE.md`, `.gitignore` (`context/`), stage↔issue mapping, ADR-001 (SDK 0.18.2 pin) | 0.5 h |
| 2 | `N-4-model-runtime` → `N-4: Add ESM skeleton and eval contract` | `package.json` (type module, engines ≥22.17, scripts), `.nvmrc`, `qvac-eval.json`, `qvac.config.json` (`cacheDirectory: data/models`, plugins: completion + embedding), `src/` dirs, CI `npm ci && npm test` | 1.5 h |
| 3 | `N-4: Add model manifest and hardware tiers` | `models.json` draft from ARCHITECTURE D7, `capability.mjs` as a pure function over `SystemResources`, unit tests with fixtures (8 GB iGPU, 16 GB Metal, 32 GB Vulkan) | 1.5 h |
| 4 | `N-4: Add models:fetch with registry, HTTPS and filesystem sources` | `downloadAsset()` per role for the detected tier and one tier below; `fallbackSrc` HTTPS; `--from-dir` import with `modelType`; sha256 + size check; `data/models/manifest.json`; Ctrl+C → `cancel({ requestId })` keeps the partial file, `--discard` clears it; rerun skips verified files | 3 h |
| 5 | `N-4: Add runtime lifecycle and cancel registry` | `runtime/*`, `entry/node.mjs`: start loads embed + chat, `/v1/models` 200 only after that, `/v1/cancel/:id`, `/v1/chat/completions` → 501, PID file, SIGINT/SIGTERM → cancel all → unload all → `close()`; `serve:stop` | 3 h |
| 6 | `N-4: Add lifecycle and cancellation tests` | unit: tiers, manifest resolution, cancel registry, offline guard. e2e (`MERIDIAN_E2E=1`): fetch small models → load → `completion` → cancel mid-stream → unload → close; download cancel leaves no orphan file | 2 h |
| 7 | `N-4: Document model sources, tiers and offline policy` | README, ADR-002 provisioning + offline guard, ADR-003 tiers, Raj notes (what is on disk) | 1 h |

Total ≈ 12.5 h of the 40–50 h budget. Push and PRs only on your go.

## 4. Design points that matter

- **Cache + manifest, not either.** SDK stores downloads in `cacheDirectory` (`data/models`) and `loadModel({ modelSrc: CONSTANT })` then loads from cache with checksum validation and no registry call. `manifest.json` records per role/tier: source (`registry` | `https` | `fs`), constant or path, sha256, size, fetchedAt. `serve` reads the manifest and **fails fast** ("run `npm run models:fetch`") if any required file is missing, so it can never start a download during offline eval. Edit to D11.
- **Three sources (1.2 needs two).** Registry: `modelRegistrySearch()` for discovery, catalog constants for download. HTTPS: `fallbackSrc` on the same constant, validated against the catalog checksum. Filesystem: `--from-dir` or `MERIDIAN_MODELS_DIR`, loaded via local path + explicit `modelType`, hash recorded by us.
- **Tiers.** S: `QWEN3_600M_INST_Q4`; M (default, the 2019 laptop): `QWEN3_5_2B_MULTIMODAL_Q4_K_M`; L: `QWEN3_4B_INST_Q4_K_M`. Embeddings `EMBEDDINGGEMMA_300M_Q8_0` on all tiers. Inputs: total RAM, free RAM, GPU backend (`vulkan`/`metal`/CPU), unified memory. `MERIDIAN_TIER` overrides; the chosen tier and reason are logged. ASR/TTS/VLM rows exist in `models.json` but are not fetched or loaded in Stage 1.
- **Cancel registry.** Every long SDK call goes through `runtime.track()`: `loadModel`/`downloadAsset` expose `requestId` synchronously on the returned promise; `completion` exposes it on its handle. `POST /v1/cancel/:id` and shutdown both call `cancel({ requestId })`. One registry for loads, downloads and inference (1.4).
- **Lifecycle.** `acquire(role)` loads on first use (refcount), `release(role)` decrements; loads are serialized; on an out-of-memory load error the next lower tier is tried once, then a clear error. `stop()` = cancel all → unload all → `close()` and is idempotent.
- **Plugins.** `qvac.config.json` starts with `llamacpp-completion` + `llamacpp-embedding`; whisper and TTS plugins are added in the stage that uses them (6.2.1 = only what is used). Edit to D12.
- **Runtime boundary (D3).** Only `src/runtime/` imports `@qvac/sdk`; `http/` sees `runtime` only. The N-2 branch's `session.js` and `select-model.js` fold into `runtime/` when merged; `delegate` becomes an option of `acquire('chat', { delegate })`.

## 5. Acceptance

| Req | Check |
|---|---|
| 1.1 | `serve` opens no network connection: unit test proves the offline guard; e2e run after `models:fetch` with the network interface down on the dev machine |
| 1.2 | `models:fetch --source registry`, `--source https`, `--from-dir` each produce a verified manifest entry; log shows source, size, sha256 |
| 1.3 | e2e: load → `completion` → unload → `close`; after `serve:stop` the PID is gone and no worker process remains; `getLoadedModelInfo` fails for the unloaded id |
| 1.4 | e2e: cancel a download at ~30 % → process exits 0, partial kept or discarded by flag; cancel a completion mid-stream via `/v1/cancel/:id` → stream ends, runtime idle, next request works |
| N-01 DoD | `npm run serve` on 127.0.0.1:11434, `GET /v1/models` → 200 only when ready; scripts exist for every `qvac-eval.json` command (`corpus:ingest` is a no-op stub until Stage 2) |

## 6. Coordination with the N-2 branch (Matthew)

- Reuse his `config`/`logger`/`serve-stop`/PID conventions and `@qvac/sdk@0.18.2` so the merge is mechanical.
- His `/v1/chat/completions` is a raw pass-through with `citations: []`; it fails 6.1.1 and D3. Suggest replacing it with the same 501 until N-04 lands.
- His hardware selection lives in `select-model.js`; propose `runtime/capability.mjs` becomes the single place and his P2P work calls `acquire('chat', { delegate })`. Needs a 15-minute sync, not a code decision.

## 7. Decisions to approve

1. Two branches (`N-3-architecture`, `N-4-model-runtime`) vs one.
2. `models:fetch` default = detected tier + one lower; `--tier all` for the provider box.
3. Stage 1 ships `/v1/chat/completions` as 501, not a pass-through.
4. Plugin list grows with usage (2 now) instead of 4 from day one.
5. Restore the deleted team rules (`git-workflow`, `non-negotiables`) from commit `5085866` in the architecture branch, or leave that to the team.
