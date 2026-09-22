import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import contract from '../qvac-eval.json' with { type: 'json' }
import qvac from '../qvac.config.json' with { type: 'json' }

const abs = (rel) => fileURLToPath(new URL(rel, new URL('../', import.meta.url)))
const base = new URL(contract.baseUrl)
const oneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}, not ${value}`)
  return value
}

export const config = {
  // qvac-eval.json is the contract; the env vars exist so a developer can run a
  // second instance next to something else already on the port.
  host: process.env.HOST ?? base.hostname,
  port: Number(process.env.PORT ?? base.port),
  apiPrefix: base.pathname.replace(/\/$/, ''),
  readyTimeoutSec: contract.readyTimeoutSec,
  chatModel: contract.models.chat,
  embeddingModel: contract.models.embedding,
  // Where the SDK keeps downloaded weights. Left at the SDK default so one
  // machine caches them once for every checkout; qvac.config.json can move it,
  // but only to an absolute path, so it is not set in the repo.
  cacheDir: qvac.cacheDirectory ?? join(homedir(), '.qvac', 'models'),
  modelsDir: abs('data/models'),
  manifestPath: abs('data/models/manifest.json'),
  // What the QVAC registry listed the last time `npm run models:list -- --refresh`
  // ran with the network up. `serve` only reads it, for GET /v1/models/catalog.
  registryPath: abs('data/models/registry.json'),
  pidPath: abs('data/serve.pid'),
  sessionsDir: abs('data/sessions'),
  // Written only for requests that carry `x-eval-run`; see src/http/trace.js.
  tracesDir: abs('data/traces'),
  // How many of the newest sessions keep their KV-cache file on disk.
  cachedSessions: Number(process.env.MERIDIAN_CACHED_SESSIONS ?? 5),
  importDir: process.env.MERIDIAN_MODELS_DIR ?? '',
  tierOverride: process.env.MERIDIAN_TIER?.toUpperCase() ?? '',
  logContent: process.env.LOG_CONTENT === '1',
  // On-demand models (speech, vision) give their memory back this long after
  // the last request. The fleet laptop cannot hold them next to the chat model.
  idleUnloadMs: Number(process.env.MERIDIAN_IDLE_UNLOAD_MS ?? 5 * 60_000),
  // Chat and embeddings stay loaded while the assistant is in use and give
  // their memory back after this long without a request; the next request
  // loads them again (about 2 s on the dev Mac, about 5 s on the fleet laptop)
  // and the session's KV file is picked up from disk. 0 keeps them until stop.
  residentIdleMs: Number(process.env.MERIDIAN_RESIDENT_IDLE_MS ?? 60 * 60_000),
  // The chat page and the test console. MERIDIAN_UI=0 serves the API alone,
  // which is also what a bundle built with `npm run build -- --no-ui` does.
  ui: process.env.MERIDIAN_UI !== '0',
  // Retrieval strategy for the A/B eval (ADR-012). The defaults are the shipped
  // behaviour; `npm run eval -- --variant <name>` starts serve with the others.
  retrieval: {
    // auto: search before every turn. tool: search before the first turn of a
    // session only; later turns retrieve through the search_documents tool.
    mode: oneOf(process.env.MERIDIAN_RETRIEVAL_MODE ?? 'auto', ['auto', 'tool'], 'MERIDIAN_RETRIEVAL_MODE'),
    // 1: a turn with history first asks the chat model for a standalone search query.
    rewrite: process.env.MERIDIAN_QUERY_REWRITE === '1',
    // rrf fuses cosine and BM25; cosine and bm25 rank by one of them alone.
    fusion: oneOf(process.env.MERIDIAN_FUSION ?? 'rrf', ['rrf', 'cosine', 'bm25'], 'MERIDIAN_FUSION'),
    // all: the excerpts of every turn stay in the context (ADR-011). current
    // (default): only the last turn carries excerpts; earlier user turns are
    // replayed as the bare question, so the context stops growing with the
    // documents and an answer can no longer lean on a chunk retrieved five
    // turns ago.
    layout: oneOf(process.env.MERIDIAN_CONTEXT_LAYOUT ?? 'current', ['all', 'current'], 'MERIDIAN_CONTEXT_LAYOUT'),
    // How many retrieved chunks a turn puts in front of the model.
    topK: Math.max(1, Number(process.env.MERIDIAN_CHAT_TOPK ?? 5) || 5),
    // Context budget in tokens for layout current, 0 for none. The default
    // is 0.8 of the 32768 every tier runs with: the measured configuration of
    // the 2026-09-21 run, where it held the cache across a conversation
    // (ratio 0.72-0.88 on the multi-turn categories) and compacted four times
    // in 410 turns. At 0 the server answers every turn with a full prefill.
    // Rewriting an earlier message invalidates the KV cache: the SDK sends
    // only the unsaved tail and the addon appends whatever it is given, so
    // the old excerpts cannot be taken back out of the cached state. With a
    // budget the excerpts of earlier turns stay in the cached prefix, and the
    // turn that would cross the budget drops the cache and replays the
    // conversation clean — one prefill instead of one per turn.
    budget: Math.max(0, Number(process.env.MERIDIAN_CONTEXT_BUDGET ?? 26214) || 0),
    // sdk: completion() through the SDK, which commits the whole turn --
    // excerpts included -- into the session's KV file. direct: the llama.cpp
    // addon underneath, where `saveCacheToDisk` is decided per call, so the
    // session's cached state holds the bare conversation and the excerpts live
    // and die with a throwaway key (docs/todo-5.md). direct has no cancel
    // registry and no P2P delegation, so it is opt-in.
    engine: oneOf(process.env.MERIDIAN_CHAT_ENGINE ?? 'sdk', ['sdk', 'direct'], 'MERIDIAN_CHAT_ENGINE'),
    // Turn window, 0 (default) off. With a budget, the turn that would cross
    // it keeps only the last N exchanges and drops everything before them,
    // instead of keeping the whole conversation and stripping its excerpts.
    // The conversation the model then sees is [system, q1 a1 ... qN aN,
    // this question with its excerpts]; the cached prefix is rebuilt once at
    // each trim and reused in between (docs/todo-7.md).
    keepTurns: Math.max(0, Number(process.env.MERIDIAN_CONTEXT_KEEP_TURNS ?? 0) || 0),
    // How many messages of the reduced conversation a compaction leaves, 0
    // for no limit. It applies on top of the budget and only at a compaction,
    // so the replay is append-only in between and the KV cache survives.
    // Without it a compaction rewrites the excerpts away and still replays
    // the whole conversation, which is the expensive half of the two.
    keepMessages: Math.max(0, Number(process.env.MERIDIAN_CONTEXT_KEEP_MESSAGES ?? 10) || 0),
    // A compaction also drops the tool rounds of the turns before it -- the
    // call and its result. In tool mode the retrieved documents arrive in the
    // result, so with MERIDIAN_DROP_TOOL_ROUNDS=0 a compaction rewrites
    // nothing and the context does not shrink.
    dropToolRounds: process.env.MERIDIAN_DROP_TOOL_ROUNDS !== '0',
    // 1: the agent-loop system prompt -- an explicit order for choosing a
    // tool, and the rule never to call a fact missing before searching for it.
    agentPrompt: process.env.MERIDIAN_AGENT_PROMPT === '1',
    // Retrieval mode `tool` used to search by itself on the first turn of a
    // session, which made that turn unlike every other one: the model was
    // handed its excerpts and had nothing to route. 0 (the default) leaves
    // the first turn to the model like any other, so a single-turn case
    // measures the agent loop rather than the server's own search.
    toolFirstTurn: process.env.MERIDIAN_TOOL_FIRST_TURN === '1',
  },
  // Sliding-window context for the chat role (llama.cpp `n_discard`, exposed
  // by the addon and the SDK as modelConfig.n_discarded). 0, the default, is
  // off: a turn that would cross ctx_size throws `context overflow at batch
  // prefill step` and the live sequence is lost. Above 0 the addon drops that
  // many tokens from the front of the window instead and carries on; the
  // primed prefix (the system prompt) is protected, the oldest turns are not
  // (measured in evals/exp/kv-discard). MERIDIAN_CHAT_CTX overrides the tier's
  // ctx_size so the window can be exercised on a small context.
  chatDiscard: Math.max(0, Number(process.env.MERIDIAN_CHAT_DISCARD ?? 0) || 0),
  // 1: the tool declarations are written into the system prompt instead of
  // being handed to the SDK as `tools`. The system prompt is the primed
  // prefix, which the sliding window protects, so the block is prefilled once
  // per session rather than re-sent with every turn -- measured at 439 tokens
  // a turn while the window is on, because an evictable block cannot be
  // assumed cached. The calls then come out of the model's text through
  // src/chat/tool-markup.js instead of the SDK's own parser (docs/todo-6.md).
  toolsInSystem: process.env.MERIDIAN_TOOLS_IN_SYSTEM === '1',
  chatCtx: Math.max(0, Number(process.env.MERIDIAN_CHAT_CTX ?? 0) || 0),
  // Generation budget of a chat round, reasoning included. With
  // chatReasoningBudget in place no honest turn has come near it: across the
  // 516 turns of the 2026-09-21 and 2026-09-22 runs the longest was 897
  // tokens and p99 was 701. Everything above 1024 was the sampler repeating a
  // paragraph until the budget ran out, and at 4096 three such turns in a row
  // added 12000 tokens to a session and the next one died on `context
  // overflow at batch prefill step (34377 tokens, max 32768)`.
  // Until 2026-09-21 the SDK path asked for 320 and never got it -- the
  // caller's own (empty) generationParams was spread over the defaults in
  // src/chat/answer.js -- so the addon's own budget ran instead and one turn
  // generated 11853 tokens.
  chatPredict: Math.max(64, Number(process.env.MERIDIAN_CHAT_PREDICT ?? 1024) || 1024),
  directPredict: Math.max(64, Number(process.env.MERIDIAN_DIRECT_PREDICT ?? 4096) || 4096),
  // Cap on the reasoning channel of a chat round (addon `reasoning_budget`):
  // -1 leaves it open, 0 switches it off, a positive number is a token cap the
  // sampler enforces by emitting </think> itself. 512 is enough for the tool
  // choice and short of the runaway that cost one turn 43 s and an empty answer.
  chatReasoningBudget: Number(process.env.MERIDIAN_CHAT_REASONING_BUDGET ?? 512),
  // Sampler penalty on tokens already generated. 0 leaves it to the addon,
  // which applies none: 15 turns of the 2026-09-21 run repeated one paragraph
  // until they hit `predict` -- 4095 tokens, 55 to 84 seconds each.
  chatRepeatPenalty: Math.max(0, Number(process.env.MERIDIAN_CHAT_REPEAT_PENALTY ?? 1.1) || 0),
  // I.6 -- SDK profiler. '' (the default) leaves it off: `enable` installs
  // hooks on every SDK operation and `verbose` also keeps a ring buffer of
  // 1000 events, neither of which a 2019 laptop should pay for by default.
  // 'summary' aggregates only; 'verbose' adds the ring buffer.
  // Resource gauges are off in the SDK's own defaults and we ask for them:
  // memory and GPU at the moment of generation is half of what the block is
  // for, and our sampler reads RSS, which undercounts Metal.
  profile: oneOf(process.env.MERIDIAN_PROFILE ?? '', ['', 'summary', 'verbose'], 'MERIDIAN_PROFILE'),
  profileDir: abs('data/profiles'),
  // Where the direct engine keeps its per-session checkpoints. Separate from
  // the SDK's own kv-cache directory: different bookkeeping, different owner.
  directCacheDir: abs('data/kv-direct'),
  // Req 5.1 — consumer never starts a provider. Eval will not run `provide`
  // and will block outbound network, so these stay empty unless a peer key is
  // handed in from the strong box.
  providerPublicKey: process.env.QVAC_PROVIDER_PUBLIC_KEY?.trim() || '',
  hyperswarmSeed: process.env.QVAC_HYPERSWARM_SEED?.trim() || '',
  forceLocal: process.env.QVAC_FORCE_LOCAL === '1',
  assumeStrongPeer: process.env.QVAC_ASSUME_STRONG_PEER === '1',
  heartbeatRetries: Number(process.env.QVAC_PEER_HEARTBEAT_RETRIES ?? 3),
  heartbeatTimeoutMs: Number(process.env.QVAC_PEER_HEARTBEAT_TIMEOUT_MS ?? 15_000),
  heartbeatRetryDelayMs: Number(process.env.QVAC_PEER_HEARTBEAT_RETRY_DELAY_MS ?? 1000),
  heartbeatIntervalMs: Number(process.env.QVAC_PEER_HEARTBEAT_INTERVAL_MS ?? 15_000),
  delegateTimeoutMs: Number(process.env.QVAC_DELEGATE_TIMEOUT_MS ?? 60_000),
}
