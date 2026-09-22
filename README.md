# Meridian on-device assistant

A local-first assistant for Meridian Components built on the QVAC SDK.
Inference, embeddings and retrieval run on the user's machine or on a peer
Meridian controls. No cloud AI APIs.

This is a **qualification exercise** for prospective QVAC Solutions service
providers. It is provisional and informative only: completing it grants no
QVAC Solutions Provider status and authorizes no claim of partnership with
Tether. The client, Meridian Components, is fictional.

## What works today

Retrieval, citations, streaming and tools are in. `npm run corpus:ingest`
chunks and embeds the corpus into LanceDB; `POST /v1/chat/completions`
retrieves, grounds the answer, cites the files, streams with
`stream: true`, and lets the model call `list_documents` and the shipped
`lookup_stock` tool on every tier (S runs Qwen3.5-0.8B, M the 2019-laptop
tier of [ARCHITECTURE.md](ARCHITECTURE.md) D7 runs Qwen3.5-2B, L
Qwen3.5-4B). The runtime provisions weights, picks a tier for the
machine, loads and unloads models, cancels work in flight, transcribes
speech, speaks answers back, answers questions about a photograph, and
can run chat, ASR and TTS on a Meridian provider peer. See
[docs/decisions.md](docs/decisions.md) for why things are the way they
are.

## Voice and vision

Speech and vision models are optional: fetch them with `--all`, and the
server loads each one on the first request and unloads it five minutes
after the last. The fleet laptop cannot hold a vision model next to the
chat model, so it does not try.

```bash
npm run models:fetch -- --all

# speak a sentence
curl -X POST http://127.0.0.1:11434/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"input":"Lead time is six weeks.","language":"en"}' -o reply.wav

# transcribe one, in whichever language it was spoken
curl -X POST http://127.0.0.1:11434/v1/audio/transcriptions -F file=@reply.wav

# the hands-free loop: speech in, answer out, spoken back
curl -X POST http://127.0.0.1:11434/v1/audio/ask -F language=en -F file=@question.wav

# a photographed nameplate or broken part
curl -X POST http://127.0.0.1:11434/v1/images/ask \
  -F 'question=What is the part number?' -F file=@nameplate.png
```

The answers the loop speaks are grounded in whatever `npm run corpus:ingest`
indexed: the top chunks go into the prompt and the `citations` array names
their files, relative to the corpus root.

Languages are detected rather than declared. Transcription quality
depends on the tier: whisper-tiny on S, whisper-base on M.

## P2P inference

Chat, transcription and speech generation may run on a stronger Meridian
box. Embeddings and vision stay on this laptop so the corpus and photos
never leave. Eval never starts a provider: `npm run serve` with no
`QVAC_PROVIDER_PUBLIC_KEY` is local-only.

On the strong machine, optionally lock it to known laptops (I.1.1).
Each laptop gets a stable identity from `QVAC_HYPERSWARM_SEED`;
`npm run identity` prints the public key to put on the allow-list:

```bash
QVAC_HYPERSWARM_SEED=<64 hex chars> npm run identity
QVAC_FIREWALL_MODE=allow QVAC_FIREWALL_PUBLIC_KEYS=<laptop-key>[,<another>] npm run provide
# same thing as arguments:
npm run provide -- <provider-seed> <laptop-key>
```

It prints a public key. On the field laptop, with that key in the
environment, `npm run serve` heartbeats the peer and loads chat (and, on
first use, ASR and TTS) with `delegate`. Heartbeats continue while the
server runs (I.1.2). If the provider drops mid-session, delegated models
fail over to local weights; when it comes back they reconnect with a
fresh DHT socket (I.1.3). `GET /health` reports `mode: "delegated"` when
chat is on the peer, plus `peerOnline` and a `delegated` flag per model.
If the peer is down at start, everything loads locally.

`POST /v1/audio/transcriptions`, `/v1/audio/speech` and `/v1/audio/ask`
all go through that same `acquire()`, so they pick up the peer without
a separate P2P path, and `/v1/chat/completions` uses the same chat model.

`QVAC_FORCE_LOCAL=1` skips the peer even when a key is set.
`QVAC_ASSUME_STRONG_PEER=1` asks the peer for L-tier weights instead of
this laptop's tier.
`QVAC_PEER_HEARTBEAT_INTERVAL_MS=0` keeps the startup probe but disables
ongoing checks.

How to prove it on two processes (firewall, heartbeat, kill the
provider, bring it back): [docs/p2p-test.md](docs/p2p-test.md).

## Requirements

Node.js 22.17 or newer (`.nvmrc` pins the version used here). Roughly 1 GB
of disk for the smallest tier, 2 GB for the fleet tier.

## Quick start

```bash
npm ci
npm run models:fetch     # needs the network
unzip corpus.zip -d data/
npm run corpus:ingest    # embeds data/corpus into data/lancedb, ~10 s
npm run serve            # does not need the network
curl http://127.0.0.1:11434/v1/models
npm run serve:stop
```

`npm run serve` binds the host and port from `qvac-eval.json`. Set `PORT`
to run beside something already on 11434. `GET /` is the chat page:
typed, dictated or spoken questions, a spoken answer on request, a photo
with a question, and the earlier chats listed on the left. `GET /ui` is
the test console that exercises each API on its own.
`GET /v1/models` answers 503 while weights load and 200 once the runtime
can serve, which is the readiness signal the eval harness polls.

## API

OpenAI-compatible where a stock client expects it, plus what the chat page
and the eval harness need. Everything is local; nothing here downloads.

| Route | Does |
| --- | --- |
| `GET /v1/models` | 503 while loading, then the two model ids from `qvac-eval.json` |
| `POST /v1/chat/completions` | retrieval, tools, grounded answer, `citations`, `usage` and `stats`; `stream: true` for SSE; honours `temperature` and `seed` |
| `x-session-id: <id>` header | names a session: the server keeps the turns and the KV cache under it and reads only the last user message from the request; without the header the request is stateless Chat Completions and the client's history is sent as given. OpenAI's `user` field is not a session key |
| `GET /v1/sessions`, `GET /v1/sessions/:id` | earlier chats, for the chat page |
| `DELETE /v1/sessions/:id` | forgets a chat: its turns and its KV-cache file |
| `POST /v1/cancel/:requestId` | cancels a load or inference in flight |
| `GET /v1/models/catalog` | every role and tier of `models.json` with what is provisioned, what the registry knows and which tiers this machine affords (see Models) |
| `POST /v1/audio/transcriptions`, `/v1/audio/speech`, `/v1/audio/ask`, `/v1/images/ask` | voice and vision (below) |
| `GET /health` | tier, mode, loaded models, resident roles unloaded while idle, in-flight requests |
| `GET /`, `GET /ui` | chat page and test console; `MERIDIAN_UI=0` serves the API alone |

Ids in `x-session-id` are 1 to 64 characters of letters, digits, `_`, `.` or
`-`, the alphabet the KV-cache key allows; anything else is a 400.

## Models

`models.json` maps each role — chat, embeddings, ASR, TTS, vision — to a
model per tier, with the catalog constant, file size, sha256 and, where
the weights come from HuggingFace, a direct HTTPS mirror.

| Flag | Source |
| --- | --- |
| `--source registry` (default) | QVAC distributed model registry |
| `--source https` | the upstream HuggingFace file, resumed on restart |
| `--source fs --from-dir DIR` | a directory the MDM pipeline provisioned |

```bash
npm run models:fetch -- --tier S            # smallest set, ~0.7 GB
npm run models:fetch -- --source https
npm run models:fetch -- --all               # include the on-demand roles
```

Ctrl+C cancels the download in flight and keeps the partial file; the next
run resumes it. `--discard` throws the partial away instead.

```bash
npm run models:list                 # every role and tier: provisioned? fits this machine?
npm run models:list -- --refresh    # ask the QVAC registry first (network) and keep data/models/registry.json
npm run models:list -- --json       # the same object GET /v1/models/catalog returns
```

`models:list` never downloads. With a registry snapshot on disk it also says
whether each `models.json` entry is in the registry with the same size
(matched by sha256); `serve` only reads that file.

Chat and embeddings stay loaded while the assistant is in use and give their
memory back after an hour without a request (`MERIDIAN_RESIDENT_IDLE_MS`, 0
keeps them until stop); `GET /health` lists them under `unloaded`. The next
request loads them again, about 2 s on the dev Mac and about 5 s on the fleet
laptop, and the sessions' KV-cache files are dropped with the model so the
reloaded one starts from one clean prefill of the stored turns (measured on
tier M: 7.2 s for that turn against 3.1 s warm; without dropping the files the
SDK prefilled the history on top of the loaded file and the context doubled).

The tier is measured from total RAM minus a 3.5 GiB OS reserve, so an 8 GB
laptop serves tier M and a 6 GB one tier S; below 5 GB `serve` stops with the
RAM it would need. The chat context is 8k tokens on S, 16k on M and 32k on L;
a session's whole conversation lives in that window (see req 6.3 below).
`MERIDIAN_TIER=S` forces one for testing. `serve`
uses the largest tier whose weights are all present, so a machine handed a
bundle built elsewhere still starts.

Retrieval has three switches, read once at start and compared by the eval
(ADR-012). The defaults are what ships; the other values exist so that
`npm run eval -- --variant <name>` can start `serve` with them.

| Variable | Default | Other values |
| --- | --- | --- |
| `MERIDIAN_RETRIEVAL_MODE` | `auto`: `search(query, 5)` before every turn | `tool`: search before the first turn of a session only; later the model calls `search_documents(query)` when the conversation's excerpts do not hold the answer |
| `MERIDIAN_QUERY_REWRITE` | `0` | `1`: a turn with history first asks the chat model (reasoning off, 48 tokens) for a standalone search query; the original question still goes to the model; `usage` includes the rewrite, `stats.rewrite_ms` and `stats.rewrite_tokens` show it alone |
| `MERIDIAN_FUSION` | `rrf`: cosine and BM25 rankings fused | `cosine`: vector ranking alone; `bm25`: full-text ranking alone. `citations[].score` is the RRF score, the cosine similarity or the BM25 score |
| `MERIDIAN_CONTEXT_LAYOUT` | `current`: only the last user turn carries excerpts, earlier turns are replayed as the bare question, so the context holds five chunks whatever the turn number (ADR-014) | `all`: excerpts stay where they were shown (ADR-011); the context grows with every retrieval and the KV cache is reused end to end |
| `MERIDIAN_CHAT_TOPK` | `5` chunks in front of the model per turn | any positive number |
| `MERIDIAN_CONTEXT_BUDGET` | `0`: layout `current` rewrites the history every turn, so the turn is prefilled whole | tokens, e.g. `8000`: keep the earlier excerpts in the cached prefix and the KV cache with them until the context would cross the budget, then compact once |
| `MERIDIAN_CHAT_ENGINE` | `sdk`: `completion()` through the SDK, which commits the whole turn — excerpts included — into the session's KV file | `direct`: the llama.cpp addon underneath, where the cached state holds the bare conversation and the excerpts live in a key thrown away with the turn (docs/todo-5.md). No cancel registry, no P2P delegation |
| `MERIDIAN_DIRECT_PREDICT` | `4096` generated tokens per round on the direct engine, reasoning included | any positive number |
| `MERIDIAN_CHAT_PREDICT` | `4096` generated tokens per round on the SDK path, reasoning included | any positive number; below ~1024 the thinking of a hard question eats the answer |
| `MERIDIAN_CHAT_REASONING_BUDGET` | `512` tokens of reasoning per round; the sampler closes `</think>` itself once it is spent | `-1` leaves the channel open, `0` switches it off; `/no_think` only damps Qwen3.5, it does not stop it |
| `MERIDIAN_PROFILE` | unset: the SDK profiler is off | `summary` aggregates operation phases, `verbose` adds a 1000-event ring buffer with memory and GPU gauges. `GET /v1/profile` reads it live; a dump lands in `data/profiles/` when serve stops |
| `MERIDIAN_CHAT_DISCARD` | `0`: a turn that crosses the context throws `context overflow` and the session's KV state goes with it | tokens the addon's sliding window drops off the front instead (`modelConfig.n_discarded`); the system prompt is protected, the oldest turns are not, and nothing tells the application what was lost (docs/todo-6.md) |
| `MERIDIAN_CHAT_CTX` | the tier's own `ctx_size` from `models.json` (16384 on M) | overrides it for the chat role; it must still hold the largest single prompt, or a replay after a lost cache overflows |
| `QUERY_HISTORY_TURNS` | `3` user questions in the search text of a follow-up (`QUERY_HISTORY_WHEN=elliptical`, so a question that names its own subject searches for itself) | `1` turns it off; `QUERY_HISTORY_CHARS`, `_MODE`, `_ORDER`, `_WHEN` are the rest of the knobs (`src/rag/query-history.mjs`) |

## What is written to disk

| Path | Contents |
| --- | --- |
| `~/.qvac/models` | model weights, downloaded once per machine |
| a private temp file | an uploaded recording or photo, deleted as soon as it is read |
| `data/models/manifest.json` | role, tier, source, path, size, sha256 |
| `data/models/https/` | weights fetched over HTTPS rather than the registry |
| `data/lancedb/` | the corpus, chunked and embedded |
| `data/models/registry.json` | what the QVAC registry listed the last time `models:list --refresh` ran; name, size, checksum and quantization per model, no download keys |
| `data/sessions/<id>.json` | every turn made under a session id: query, answer, citations, kind, the messages the model saw, and a small preview of a photo; `DELETE /v1/sessions/<id>` or deleting the file forgets the chat |
| `~/.qvac/kv-cache/meridian-<id>/` | the SDK's KV state for a session, one file; kept for the newest five sessions, deleted when older ones start (`MERIDIAN_CACHED_SESSIONS`), when the session is deleted, and when the chat model unloads after an idle hour |
| `data/traces/<run>/<requestId>.json` | only for requests with an `x-eval-run` header: hits, messages, tool rounds, stats for the eval harness |
| `data/serve.pid` | the running server's PID |

Nothing else. Logs carry request metadata only: prompts and corpus text
are never logged (`qvac.config.json` keeps the SDK's own log at `warn`, which
is where its prompt echo would otherwise appear). `serve` opens no outbound connection.

## Build

```bash
npm run build              # plugin-scoped worker bundle in qvac/, app bundle in dist/
npm run build:full         # also the full-SDK bundle, and writes docs/bundle-size.md
npm run build -- --no-ui   # app bundle without the chat page and test console (ejs, @fastify/view)
```

The UI is a dynamic import behind `MERIDIAN_UI`, so a `--no-ui` bundle serves
the API alone and logs once that the UI is not in this build.

## Tests

```bash
npm test          # unit; no model weights, no native addons, runs in CI
npm run test:e2e  # needs MERIDIAN_E2E=1 and a completed models:fetch
```

P2P live checks (two processes, real DHT) are not in CI. Walk through
[docs/p2p-test.md](docs/p2p-test.md).

## Evals

```bash
npm run eval                                   # all categories on the tier in evals/config.json
npm run eval -- --tier M --only tools --runs 1 --no-judge
npm run eval -- --only multiquery              # ten multi-question sessions, retrieval and judge per turn
npm run eval -- --only multiquery --no-judge --variant rewrite   # the same set against a serve with MERIDIAN_QUERY_REWRITE=1
npm run eval:compare -- evals/results/<baseline> evals/results/<variant>...   # tokens, recall@3, tool calls, latency side by side
```

`evals/run.mjs` starts a fresh `serve` on port 11435, replays the scripted
cases under `evals/cases/`, scores every answer in code, samples memory
through load, generation and unload, grades the `single` answers with a
local judge model, and writes `evals/results/<ts>/report.html`. Format of
the cases, metrics and the judge: [evals/README.md](evals/README.md).

## Repository

| Path | What |
| --- | --- |
| `src/runtime/` | the only consumer code that imports `@qvac/sdk` |
| `src/p2p/provider.js` | `npm run provide` on the strong box; optional public-key firewall |
| `docs/p2p-test.md` | how to test firewall, heartbeat, failover |
| `src/http/` | OpenAI-compatible surface; talks to the runtime, never the SDK |
| `views/` | chat page at `GET /`, test console at `GET /ui` |
| `src/chat/answer.js` | the one seam a question passes through to become an answer |
| `src/audio/wav.js` | PCM in and out of the RIFF container every client expects |
| `scripts/models-fetch.js` | provisioning, the one step that uses the network |
| `models.json` | roles, tiers, checksums, mirrors |
| `qvac-eval.json` | the contract the Tether harness runs |
| `evals/` | our own eval harness: cases, runner, metrics, judge, report |
| `qvac.config.json` | the QVAC plugins this build includes |
