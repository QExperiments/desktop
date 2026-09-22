# Testing P2P resilience (I.1)

Unit tests cover parsing, identity and the heartbeat state machine.
They do not talk to Hyperswarm. The checks below prove the live path:
provider firewall (I.1.1), ongoing heartbeats (I.1.2), failover and
reconnect when the provider dies mid-session (I.1.3).

Chat, ASR and TTS may run on the peer. Embeddings and vision stay local.
Eval never sets `QVAC_PROVIDER_PUBLIC_KEY`, so `npm run serve` with no
key must stay local-only and open no outbound P2P.

## Automated

```bash
npm test
```

That runs `test/unit/firewall.test.js`, `test/unit/identity.test.js` and
`test/unit/peer.test.js`. No weights, no second process.

```bash
npm run models:fetch
MERIDIAN_E2E=1 npm run test:e2e
```

Local load → infer → cancel only. Still no provider.

## Live path: two processes

One machine, two terminals is enough. Fetch weights once. Shorten the
heartbeat so you are not waiting 15s between probes.

```bash
CONSUMER_SEED=$(openssl rand -hex 32)
PROVIDER_SEED=$(openssl rand -hex 32)
```

### 1. Consumer public key (allow-list entry)

```bash
npm run identity -- "$CONSUMER_SEED"
```

Copy the 64-char hex. That is `$CONSUMER_KEY`.

### 2. Provider (strong box)

```bash
npm run provide -- "$PROVIDER_SEED" "$CONSUMER_KEY"
```

Same thing via env:

```bash
QVAC_HYPERSWARM_SEED=$PROVIDER_SEED \
QVAC_FIREWALL_MODE=allow \
QVAC_FIREWALL_PUBLIC_KEYS=$CONSUMER_KEY \
npm run provide
```

Expect `provider firewall` with `mode: "allow"`, then a `publicKey`.
That printed key is `$PROVIDER_KEY`. Keep this process running.

### 3. Consumer (field laptop)

```bash
QVAC_HYPERSWARM_SEED=$CONSUMER_SEED \
QVAC_PROVIDER_PUBLIC_KEY=$PROVIDER_KEY \
QVAC_PEER_HEARTBEAT_INTERVAL_MS=5000 \
MERIDIAN_UNGROUNDED=1 \
npm run serve
```

`MERIDIAN_UNGROUNDED=1` only so `/v1/chat/completions` is not 501 while
you poke at failover. Speech routes work without it.

```bash
curl -s http://127.0.0.1:11434/health
```

Happy path: `peerOnline: true`, `mode: "delegated"`, chat model's
`delegated: true`. `GET /` shows the same pills. Consumer log:
`provider heartbeat ok`.

Without `QVAC_PROVIDER_PUBLIC_KEY`, `/health` stays `mode: "local"` and
`peerOnline: false`.

## I.1.1 Firewall

Restart the provider with a key that is **not** `$CONSUMER_KEY`:

```bash
npm run provide -- "$PROVIDER_SEED" "$(openssl rand -hex 32)"
```

The consumer heartbeat should fail. `/health` → `peerOnline: false`,
`mode: "local-fallback"`. Put `$CONSUMER_KEY` back; after the next
heartbeat it should return to `delegated`.

An open provider (`npm run provide` with no keys) still accepts anyone.
The log says so.

## I.1.2 Heartbeat

Leave both processes up. Kill the provider with Ctrl+C. Within one
interval plus one timeout (about 5–20s with the 5s interval above)
the consumer logs `provider heartbeat failed`, then
`provider dropped; failing over to local models`. `/health` →
`peerOnline: false`.

`QVAC_PEER_HEARTBEAT_INTERVAL_MS=0` keeps the startup probe and
disables the loop. Failover then only happens on a delegated call
failure, not on a background tick.

## I.1.3 Failover and reconnect

1. Provider up → `/health` delegated.
2. Stop the provider. Wait for the consumer to fail over.
3. Chat (or `/v1/audio/speech`) still answers, now on local weights.
   `/health`: `mode: "local-fallback"`, chat `delegated: false`.
4. Start the provider again with the **same** `$PROVIDER_SEED` so
   `$PROVIDER_KEY` is unchanged.
5. Next heartbeat: consumer logs
   `provider back; reconnecting delegated models`.
   `/health`: `peerOnline: true`, `mode: "delegated"`.

If the public key changes across restarts, the consumer still points at
the old key and will not find the box. That is why the provider seed is
fixed.

## Signals

| Place | What |
| --- | --- |
| `GET /health` | `peerOnline`, `mode`, per-model `delegated` |
| `GET /` | same pills, Refresh /health |
| consumer log | heartbeat ok/failed, dropped, reconnecting |
| provider log | firewall mode and keys, public key |

Chat and ASR/TTS share `acquire()`, so one delegated flag on chat is
enough to know the peer path is live. Embed and vision must stay
`delegated: false`.
