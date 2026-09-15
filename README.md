# Meridian on-device assistant

A local-first assistant for Meridian Components built on the QVAC SDK.
Inference, embeddings and retrieval run on the user's machine or on a peer
Meridian controls. No cloud AI APIs.

This is a **qualification exercise** for prospective QVAC Solutions service
providers. It is provisional and informative only: completing it grants no
QVAC Solutions Provider status and authorizes no claim of partnership with
Tether. The client, Meridian Components, is fictional.

## What works today

This branch covers Req #1 — the model runtime. It provisions weights,
picks a tier for the machine, loads and unloads models, and cancels work
in flight. Retrieval, citations, tools, voice, vision and P2P delegation
arrive in later stages; see [ARCHITECTURE.md](ARCHITECTURE.md) for the
plan and [docs/decisions.md](docs/decisions.md) for why things are the way
they are.

`POST /v1/chat/completions` answers **501** on purpose. Req 6.1.1 requires
that route to run retrieval and tools, and a placeholder proxy is the
shortcut that ends up shipping.

## Requirements

Node.js 22.17 or newer (`.nvmrc` pins the version used here). Roughly 1 GB
of disk for the smallest tier, 2 GB for the fleet tier.

## Quick start

```bash
npm ci
npm run models:fetch     # needs the network
npm run serve            # does not
curl http://127.0.0.1:11434/v1/models
npm run serve:stop
```

`npm run serve` binds the host and port from `qvac-eval.json`. Set `PORT`
to run beside something already on 11434. `GET /v1/models` answers 503
while weights load and 200 once the runtime can serve, which is the
readiness signal the eval harness polls.

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
| `data/models/manifest.json` | role, tier, source, path, size, sha256 |
| `data/models/https/` | weights fetched over HTTPS rather than the registry |
| `data/serve.pid` | the running server's PID |

Nothing else. Logs carry request metadata only: prompts and corpus text
are never logged. `serve` opens no outbound connection.

## Tests

```bash
npm test          # unit; no model weights, no native addons, runs in CI
npm run test:e2e  # needs MERIDIAN_E2E=1 and a completed models:fetch
```

## Repository

| Path | What |
| --- | --- |
| `src/runtime/` | the only code that imports `@qvac/sdk` |
| `src/http/` | OpenAI-compatible surface; talks to the runtime, never the SDK |
| `scripts/models-fetch.js` | provisioning, the one step that uses the network |
| `models.json` | roles, tiers, checksums, mirrors |
| `qvac-eval.json` | the contract the Tether harness runs |
| `qvac.config.json` | the QVAC plugins this build includes |
