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
`lookup_stock` tool. Tool calls need tier M or larger (the 2019-laptop
tier in [ARCHITECTURE.md](ARCHITECTURE.md) D7); tier S answers from the
corpus only. The runtime provisions weights, picks a tier for the
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
a separate P2P path. `/v1/chat/completions` is still 501 until
retrieval; when that route lands it will use the same chat model.

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

The tier is measured from total RAM minus a 3.5 GiB OS reserve, so an 8 GB
laptop serves tier M. `MERIDIAN_TIER=S` forces one for testing. `serve`
uses the largest tier whose weights are all present, so a machine handed a
bundle built elsewhere still starts.

## What is written to disk

| Path | Contents |
| --- | --- |
| `~/.qvac/models` | model weights, downloaded once per machine |
| a private temp file | an uploaded recording or photo, deleted as soon as it is read |
| `data/models/manifest.json` | role, tier, source, path, size, sha256 |
| `data/models/https/` | weights fetched over HTTPS rather than the registry |
| `data/lancedb/` | the corpus, chunked and embedded |
| `data/sessions/<id>.json` | every turn made under a session id: query, answer, citations, kind, the messages the model saw, and a small preview of a photo; delete the file to forget the chat |
| `~/.qvac/kv-cache/meridian-<id>/` | the SDK's KV state for a session, one file; kept for the newest five sessions, deleted when older ones start (`MERIDIAN_CACHED_SESSIONS`) |
| `data/traces/<run>/<requestId>.json` | only for requests with an `x-eval-run` header: hits, messages, tool rounds, stats for the eval harness |
| `data/serve.pid` | the running server's PID |

Nothing else. Logs carry request metadata only: prompts and corpus text
are never logged. `serve` opens no outbound connection.

## Build

```bash
npm run build        # plugin-scoped worker bundle in qvac/, app bundle in dist/
npm run build:full   # also the full-SDK bundle, and writes docs/bundle-size.md
```

## Tests

```bash
npm test          # unit; no model weights, no native addons, runs in CI
npm run test:e2e  # needs MERIDIAN_E2E=1 and a completed models:fetch
```

P2P live checks (two processes, real DHT) are not in CI. Walk through
[docs/p2p-test.md](docs/p2p-test.md).

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
| `qvac.config.json` | the QVAC plugins this build includes |
