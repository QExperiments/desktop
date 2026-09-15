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
