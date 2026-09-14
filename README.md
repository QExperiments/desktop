# Meridian Components — on-device assistant

Qualification exercise for prospective **QVAC Solutions** service providers.
This assessment is **provisional and informative only**. Completing it does not
grant QVAC Solutions Provider status and does not authorize any public claim of
partnership or affiliation with Tether.

The working application is not here yet. This repo currently holds the brief,
agent rules, and the QVAC contract we will implement against.

## Client (fictional)

**Meridian Components, Inc.** — industrial manufacturer, 312 employees,
Americas / EMEA / APAC. Largest line: ServoDrive X4.

Commercial knowledge is scattered across quarterly sales reports, deal emails,
pipeline-review recordings, support policies, and quality-board notes. Reps
spend ~20 minutes digging before a call; about once a month someone quotes a
stale figure to a customer. A cloud assistant was killed after a month: cost,
unclear margin, and **customer / pipeline data leaving the device**.

They already have an internal chat tool that speaks an **OpenAI-compatible
API**. They do not want a third app that three people remember to open.

**Jobs to cover in the pilot**

- Field engineers in plants (often gloved) need answers on a part or account
  without calling the office.
- Sales need stock / lead time mid-call without putting the customer on hold.
- 18 new hires next quarter (12 sales / SE, 6 CS) should self-serve instead of
  interrupting seniors.

**Non-negotiable constraints**

- No customer or commercial data to a third-party AI service. Inference may run
  on Meridian hardware or another Meridian-controlled machine only.
- Every answer must be traceable to a source document.
- IT must be able to deploy it through an MDM fleet of 300+ machines. A
  multi-gigabyte installer is a non-starter (model weights download later).
- Must work offline on the weakest device: a 2019 business laptop, iGPU, 8 GB RAM.

## What we will build

A first draft of Meridian’s assistant using **Node.js** and the **Bare**
runtime, with local AI from the **QVAC SDK** (`@qvac/sdk`).

QVAC is Tether’s stack for local-first, on-device AI: inference, embeddings /
RAG, multimodality, and peer-to-peer delegated inference on the customer’s
hardware — **no cloud AI APIs**.

| Need | QVAC surface we will use |
| --- | --- |
| Stay on Meridian hardware | `loadModel` → inference → `unloadModel` → `close`; cancel in-flight work by `requestId` |
| Find / fetch models without bloating the installer | `modelRegistryList()` / `modelRegistrySearch()`, filesystem, HTTPS (e.g. Hugging Face), or `pear://` Hyperdrive |
| Ground answers in the provided corpus | `ragChunk()` + `embed()` into a local vector store; citations on every answer |
| Stream instead of a long pause | `completion({ stream: true })` |
| Do work besides chat | tool-capable model + Zod schemas in `completion({ tools })`; `list_documents` and the provided stock tool |
| Hands-free, multilingual, in the plant | Whisper / Parakeet `transcribe()` and/or `transcribeStream()`; TTS; VLM image + text |
| Weak field laptop | `startQVACProvider()` + `loadModel({ delegate: { providerPublicKey, fallbackToLocal: true } })`; pick model/quant from `getSystemResources` / `assessModelFit` |
| Existing chat tool + IT | OpenAI-compatible HTTP (`qvac serve openai` equivalent); plugin-scoped `qvac.config.*`; tree-shaken build; per-session KV cache |

**Reference for SDK patterns only:** sibling checkout `fibiom-electron`. Copy
QVAC lifecycle, streaming, tools, RAG, STT/TTS, and plugin scoping from there.
Do **not** copy the Fibiom product, Electron shell, or finance domain.

Official docs: [docs.qvac.tether.io](https://docs.qvac.tether.io) ·
[npm @qvac/sdk](https://www.npmjs.com/package/@qvac/sdk) ·
[github.com/tetherto/qvac](https://github.com/tetherto/qvac)

## How Tether will run the submission

`qvac-eval.json` at the repo root (to be added with the app) must match:

```json
{
  "version": 1,
  "setup": "npm ci && npm run models:fetch && npm run corpus:ingest",
  "start": "npm run serve",
  "shutdown": "npm run serve:stop",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "readyPath": "/models",
  "readyTimeoutSec": 600,
  "models": { "chat": "meridian-assistant", "embedding": "meridian-embed" }
}
```

`start` must work with **outbound network blocked**. `POST /v1/chat/completions`
must run retrieval + grounding + tools, not a raw model pass-through. Grounded
answers carry a machine-readable `citations` array (`file` relative to the
corpus root). Honor `temperature` and `seed`.

Mandatory scope beats extras. Finishing > expanding.

## Agent instructions

| File | Who loads it |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Cursor, Codex, and other AGENTS.md clients |
| [CLAUDE.md](CLAUDE.md) | Claude Code (imports AGENTS.md) |
| [.agents/rules/](.agents/rules/) | Shared, tool-agnostic rules |
| [.claude/rules/](.claude/rules/) | Claude Code project rules |
| [.cursor/rules/](.cursor/rules/) | Cursor project rules |
