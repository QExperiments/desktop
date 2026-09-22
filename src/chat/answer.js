import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { search } from '../rag/retrieve.mjs'
import { config as ragConfig } from '../rag/store.mjs'
import { queryTexts } from '../rag/query-history.mjs'
import { summarize } from './stats.js'
import { createMarkupFilter, parseToolMarkup, stripThinking, stripToolMarkup } from './tool-markup.js'
import { SEARCH_DOCUMENTS, renderToolBlock, searchDocumentsTool, toolCitation, toolSchemas, tools as baseTools } from './tools.js'

// One place where a query becomes an answer. Retrieval, grounding and the
// citations array land here; the voice loop and /v1/chat/completions both go
// through it, so neither can quietly skip them.
//
// The system prompt is fixed for a serve process. The SDK names a session's
// KV-cache file after a hash of the system prompt plus the tool block, and
// under that key it sends the model only the messages it has not seen yet.
// Retrieved context therefore travels inside the user turn (or a tool result),
// never in the system prompt: one file per session, and turn N pays prefill
// for turn N alone (req 6.3).
//
// The switches of config.retrieval (ADR-012) pick the retrieval strategy:
// `mode` auto (search before every turn) or tool (search before the first
// turn of a session; later the model calls search_documents), `rewrite` (a
// turn with history first asks the model for a standalone search query) and
// `fusion` (rrf, cosine, bm25). QUERY_HISTORY_TURNS
// (src/rag/query-history.mjs) joins the automatic search text with the
// earlier questions of the conversation.
//
// `layout` (MERIDIAN_CONTEXT_LAYOUT) decides where the excerpts live.
// current, the default: only the last user turn carries them, earlier user
// turns are replayed as the bare question, so the context holds `topK`
// chunks whatever the turn number. all: they stay where they were shown
// (ADR-011) and the context grows with every retrieval.
//
// Rewriting an earlier message costs the KV cache. The SDK keys the cache by
// session, records how many messages it covers and then sends only the tail;
// the addon appends what it is given and can neither drop nor rewrite what
// the state already holds. So layout current runs with no key at all and
// pays a full prefill per turn — unless `budget` (MERIDIAN_CONTEXT_BUDGET)
// is set, and then the excerpts of earlier turns stay in the cached prefix
// until the estimated context crosses the budget: that turn drops the cache
// and replays the conversation clean, one prefill per compaction instead of
// one per turn. compactionBase() is where the two meet.
const { mode: MODE, rewrite: REWRITE, fusion: FUSION, layout: LAYOUT, topK: CHAT_TOPK, budget: CTX_BUDGET, engine: ENGINE, keepTurns: KEEP_TURNS, keepMessages: KEEP_MESSAGES, dropToolRounds: DROP_TOOL_ROUNDS, agentPrompt: AGENT_PROMPT, toolFirstTurn: TOOL_FIRST_TURN } = config.retrieval
// The direct engine keeps the excerpts out of the cached state entirely, so it
// replays every earlier turn bare and never compacts (docs/todo-5.md).
const DIRECT = ENGINE === 'direct'
// With the declarations in the system prompt the SDK is not told about the
// tools at all, so it neither renders a block nor parses the calls back: both
// move here (config.toolsInSystem).
const TOOLS_IN_SYSTEM = config.toolsInSystem

// MERIDIAN_TOOLS_IN_SYSTEM=1 moves the declarations here. Everything the
// model may call has to be in the list, so tool mode adds search_documents.
const declaredTools = (mode = MODE) => (mode === 'tool' ? [...baseTools, SEARCH_DOCUMENTS] : baseTools)

// The agent-loop prompt (MERIDIAN_AGENT_PROMPT=1): the tool choice is an
// explicit order rather than a paragraph, and the two failures the runs kept
// showing get a rule each -- calling a fact missing without having searched
// for it, and carrying one refusal into the next question.
// Neither prompt asks for /no_think any more. Qwen3.5 only damps on it (854
// characters of reasoning on the first turn of the 2026-09-21 run, with it in
// the prompt), `reasoning_budget` is the real cap, and the two together told
// the model not to open a block the sampler is obliged to close.
// (`remove_thinking_from_context` defaults to true for the Qwen3 family).
const AGENT_LINES = [
  'You are Meridian Components\' internal assistant.',
  'Answer in the language of the question, in at most three sentences.',
  '',
  'Choosing a tool, in this order:',
  '- how many units, availability, "in stock", lead time -> lookup_stock, never search_documents',
  '- which documents, files or sources exist -> list_documents',
  '- any other fact about products, policies, SLAs, prices, warranties, customers, deals or reports -> search_documents',
  '- only when this conversation already shows the exact fact asked for -> no tool, just answer',
  '',
  'When in doubt between answering from memory and searching, search. This never overrides the order above: a question about units, availability or lead time is always lookup_stock.',
  '',
  'Rules:',
  '- A new question asks for a new fact: call search_documents for it unless you can point to the sentence in this conversation that states it.',
  '- Short follow-ups ("and the June figure?", "what about EMEA?") are new questions too. Expand one into a self-contained query naming the product, customer, policy, metric and period, then search for it.',
  '- Never say a fact is missing from the documents until you have called search_documents for it at least once in this conversation.',
  '- Judge every question on its own. An earlier "not in the documents" says nothing about the next question.',
  '- Call the tool yourself, read its result, then answer in plain text. Never tell the user to call a tool.',
  '- Repeat a call only with different arguments.',
  '- Ground every number in an excerpt or a tool result of this conversation. If you do not have it, say so plainly.',
  '- Skip the search only when you can quote the sentence in this conversation that answers the question. Remembering that you saw it is not enough.',
  '- An identifier on its own (SD-X4-001, FIN-SAL-2026-Q1-011, OPP-88421, CTR-PIN-2024-019-A2) asks for the document that mentions it: search_documents for it. lookup_stock answers a question about units, not a code.',
  '- A message that asks nothing -- thanks, an acknowledgement, a goodbye -- gets one short line and no tool.',
  '- Document excerpts arrive only with the first question; later questions bring none.',
]

export const systemPrompt = (mode = MODE, { toolsInSystem = config.toolsInSystem, agent = AGENT_PROMPT } = {}) => (agent && mode === 'tool'
  ? [...(toolsInSystem ? [renderToolBlock(declaredTools(mode)), ''] : []), ...AGENT_LINES].join('\n')
  : [...(toolsInSystem ? [renderToolBlock(declaredTools(mode)), ''] : []), [
  'You are Meridian Components\' internal assistant.',
  'Answer in the language of the question, in at most three sentences.',
  mode === 'tool'
    ? 'Document excerpts come only with the first user message; later questions bring none. Before answering a later question, call search_documents with a self-contained query that names the product, customer, policy or metric the user means, unless the excerpts already in this conversation state the very fact asked for. Ground your answer in the excerpts and search results of this conversation; do not invent facts beyond them.'
    : 'A user message may open with excerpts from the company documents. Ground your answer in them and in earlier excerpts of this conversation; do not invent facts beyond them.',
  'The documents never hold stock quantities, availability or lead times; call lookup_stock for those.',
  // The excerpts arrive in front of the question, and the model answers from
  // them: over three runs of the tools cases it called no tool on five to
  // eight of eleven, saying "the documents do not contain stock quantities"
  // instead of asking lookup_stock, and listing its own five excerpts instead
  // of asking list_documents.
  'A question about how many units, availability or lead time, or about which documents or files exist, is answered by the tool and not by the excerpts, however related the excerpts look.',
  mode === 'tool'
    ? 'Tools: search_documents for any fact from the documents not yet shown in this conversation; lookup_stock for stock, availability or lead time; list_documents for the list of corpus files.'
    : 'Tools: lookup_stock for stock, availability or lead time; list_documents for the list of corpus files.',
  'Call a tool, read its result, then answer the user in plain text. Repeat a call only with different arguments. Never tell the user to call a tool; call it yourself.',
  // With a turn window the conversation the model sees starts mid-way: the
  // excerpts of the dropped turns are gone and nothing in the text says so.
  ...(KEEP_TURNS > 0 && mode === 'tool'
    ? ['This conversation may start part way through: earlier turns and their excerpts are not shown to you. If the fact asked for is not in what you can see here, call search_documents for it instead of recalling it.']
    : []),
  'If you do not have the answer, say so plainly instead of guessing a number.',
].join(' ')].join('\n'))
export const SYSTEM = systemPrompt()

// The query-rewrite step (MERIDIAN_QUERY_REWRITE=1): the chat model, without a
// KV key and with its reasoning channel off, turns an elliptical follow-up into
// a standalone search query. The original question still goes to the model and
// to the user.
export const REWRITE_SYSTEM = [
  'You turn the last user question of a conversation into one standalone query for a document search engine.',
  'Replace pronouns and references such as "it", "they", "that customer", "and the extended one" with the product, customer, policy or metric they stand for in the conversation.',
  'Keep the language and the meaning of the question; add nothing that is not asked.',
  'Reply with the query alone: no quotes, no explanation.',
].join(' ')
const REWRITE_TURNS = 3
const REWRITE_ANSWER_CHARS = 300

// Hard stop for the tool loop, whatever the per-tool limits add up to.
const MAX_TOOL_ROUNDS = 3

// The SDK's cache key for a session. Same alphabet sessions.js accepts.
export const kvCacheKey = (session) => `meridian-${String(session).replace(/[^\w.-]/g, '_').slice(0, 64)}`

// Every tool result goes back with this line. A small model otherwise reads
// the result as a cue to call the tool again instead of writing the answer.
// The last round says so outright: of the 11 turns of the 2026-09-21 run that
// reached MAX_TOOL_ROUNDS, 10 spent that round on another call and ended with
// markup and no answer. It rides in the result, so the replay stays
// append-only and the cache with it.
const AFTER_TOOL = 'Now answer the user in plain text from this result.'
const LAST_TOOL = 'No more tool calls are available for this question. Answer the user now, in plain text, from this result and what this conversation already holds.'
const afterTool = (result, last = false) => `${JSON.stringify(result)}\n${last ? LAST_TOOL : AFTER_TOOL}`

// The answer of a turn whose every round wrote markup and no prose. Never the
// empty string: that reads as a 200 with nothing in it and then sits in the
// history as a turn where the assistant said nothing.
const NO_ANSWER = 'I could not complete that lookup. Please ask again, naming the product, customer or document you mean.'

// The user turn as the model sees it: fresh excerpts first, the question last.
// Chunks shown earlier in the session are already in the model's context and
// are not repeated; they still count as citations for this answer.
const buildUserTurn = (hits, query) => {
  const fresh = hits.filter((hit) => !hit.reused)
  if (!fresh.length) return query
  const parts = fresh.map((hit, i) => `[${i + 1}] source: ${hit.file}\n${hit.content}`)
  return ['Document excerpts:', ...parts, `Question: ${query}`].join('\n\n')
}

// The question inside a stored user turn, without the excerpts that opened it.
export const rawQuery = (content = '') => {
  if (!content.startsWith('Document excerpts:')) return content
  const at = content.lastIndexOf('\n\nQuestion: ')
  return at === -1 ? content : content.slice(at + '\n\nQuestion: '.length)
}

// The earlier turns as this request replays them. Under layout all they are
// replayed as stored. Under current, the user turns before `base` are reduced
// to their question and the ones from `base` on keep their excerpts: with no
// budget `base` is the end of the history, so every earlier turn is bare;
// with one it is the message the last compaction ended at, and everything
// after it is still in the KV cache exactly as the model saw it.
export const replayHistory = (prior, layout = LAYOUT, base = layout === 'current' ? prior.length : 0, { dropTools = false } = {}) => {
  if (layout !== 'current') return prior
  const kept = prior.filter((message, i) => !(dropTools && i < base && isToolRound(message)))
  const cut = dropTools ? base - prior.slice(0, base).filter(isToolRound).length : base
  return kept.map((message, i) => (message.role === 'user' && i < cut ? { ...message, content: rawQuery(message.content) } : message))
}

// A tool round: the assistant message that carries the call, and the result
// that came back. In tool mode the retrieved documents live in the result, so
// these are what a compaction has to drop for the context to shrink at all.
export const isToolRound = (message) =>
  message.role === 'tool' || (message.role === 'assistant' && String(message.content ?? '').includes('<tool_call>'))

// Tokens, near enough to decide a compaction. The SDK exposes no tokenizer
// for the chat model, so this is calibrated against what the model actually
// counted: over the 235 first turns of the 2026-09-21 and 2026-09-22 runs the
// ratio ran 2.36 to 3.27 characters per token, median 2.78. The old 3.2 sat
// above almost all of it and so under-counted on 234 of the 235 -- by 28% on
// the turn that then died on `context overflow (34377 tokens, max 32768)`.
// A compaction decision has to err high, so the constant is the low end.
const CHARS_PER_TOKEN = 2.4
export const estimateTokens = (messages) =>
  Math.round(messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0) / CHARS_PER_TOKEN)

// A retrieved chunk is about 1200 characters of document text, near 2.9 to
// the token. The budget is what a turn may reach, so the decision is taken
// with room for the excerpts this turn is about to add — they are retrieved
// after it, since a hit counts as reused only against the context the base
// leaves in place.
// Measured at 420 tokens a rendered excerpt when a chunk was 512 tokens, so
// the reserve follows the chunk: at 384 it is 315. A fixed number here would
// hold back twice the room the excerpts need and compact twice too early.
export const EXCERPT_TOKENS = Math.round(420 * (ragConfig.chunkOpts.chunkSize / 512))

// Where the excerpts still in the context begin. Layout all keeps all of
// them (0). Layout current without a budget keeps this turn's alone
// (prior.length: every earlier turn is replayed bare). With a budget the
// previous base holds until the context it implies crosses the budget, and
// then this turn starts a clean prefix. Returning a base different from the
// one passed in means the cached state no longer matches the history and the
// caller drops it.
export const compactionBase = (prior, base = 0, { layout = LAYOUT, budget = CTX_BUDGET, system = SYSTEM, k = CHAT_TOPK } = {}) => {
  if (layout !== 'current') return 0
  if (budget <= 0) return prior.length
  const kept = Math.min(base, prior.length)
  const replayed = replayHistory(prior, layout, kept)
  const room = budget - k * EXCERPT_TOKENS
  return estimateTokens([{ content: system }, ...replayed]) <= room ? kept : prior.length
}

// Where the replayed conversation begins. Without a turn window it is always
// the start. With one, the previous start holds until the context it implies
// crosses the budget, and then everything before the last `keep` exchanges is
// dropped: the model keeps its recent conversation and loses the rest, and
// this turn's excerpts are the only ones in front of it. A start different
// from the one passed in means the cached prefix no longer matches and the
// caller drops it, exactly as a compaction does.
export const windowStart = (prior, from = 0, { keep = KEEP_TURNS, budget = CTX_BUDGET, system = SYSTEM, k = CHAT_TOPK } = {}) => {
  if (keep <= 0) return 0
  const held = Math.min(Math.max(0, from), prior.length)
  const kept = replayHistory(prior, 'current', prior.length).slice(held)
  const room = (budget > 0 ? budget : 0) - k * EXCERPT_TOKENS
  const questions = prior.reduce((list, message, i) => (message.role === 'user' ? [...list, i] : list), [])
  if (budget > 0 && estimateTokens([{ content: system }, ...kept]) <= room) return held
  if (budget <= 0 && questions.length <= keep) return held
  // An exchange is one question and whatever answered it, which in tool mode
  // is several messages, so the cut lands on the question that opens the
  // window rather than a fixed number of messages back.
  return Math.max(held, questions.length <= keep ? held : questions[questions.length - keep])
}

// The conversation without its tool rounds: the question and the answer the
// person saw, not the call the model made or the excerpts that came back.
// A window keeps recent exchanges, and a tool result is the largest thing in
// one -- five of them outweigh the budget on their own.
export const bareHistory = (prior) => prior.filter((message) =>
  message.role !== 'tool' && !(message.role === 'assistant' && String(message.content ?? '').includes('<tool_call>')))

// The last `keep` messages of a reduced conversation, cut so the replay opens
// on a question rather than half an exchange. 0 keeps everything. Applied
// only when a compaction already rewrote the history, so the replay stays
// append-only in between and the KV cache holds.
export const tailStart = (reduced, keep = KEEP_MESSAGES) => {
  if (keep <= 0 || reduced.length <= keep) return 0
  const from = reduced.length - keep
  for (let i = from; i < reduced.length; i++) if (reduced[i].role === 'user') return i
  return from
}

// What this turn replays and whether it had to compact to get there. `base`
// is where the excerpts (and, with dropTools, the tool rounds) still stand;
// `from` is where the replay begins. Both hold until the context they imply
// crosses the budget, so between compactions the replay only grows at the end
// and the SDK's cached prefix stays valid. On the turn that crosses, the
// conversation before this turn is reduced and its tail is cut to
// `keepMessages`, the caller drops the cache and pays one full prefill.
export const compactionPlan = (prior, { base = 0, from = 0, layout = LAYOUT, budget = CTX_BUDGET, system = SYSTEM, k = CHAT_TOPK, dropTools = DROP_TOOL_ROUNDS, keep = KEEP_MESSAGES } = {}) => {
  if (layout !== 'current') return { base: 0, from: 0, compacted: false }
  if (budget <= 0) return { base: prior.length, from: 0, compacted: false }
  const held = Math.min(Math.max(0, base), prior.length)
  const heldFrom = Math.min(Math.max(0, from), prior.length)
  const room = budget - k * EXCERPT_TOKENS
  const wouldSend = replayHistory(prior, layout, held, { dropTools }).slice(heldFrom)
  if (estimateTokens([{ content: system }, ...wouldSend]) <= room) return { base: held, from: heldFrom, compacted: false }
  const reduced = replayHistory(prior, layout, prior.length, { dropTools })
  return { base: prior.length, from: tailStart(reduced, keep), compacted: true }
}

// The chunk ids still in front of the model: those shown at or after `base`.
// sessions.context() reports them per turn ({ at, ids }); a plain list of ids
// (a client-supplied history, or a session written before) is taken as shown.
export const visibleChunks = (shown = [], base = 0) =>
  shown.flatMap((entry) => (typeof entry === 'string' ? [entry] : (entry?.at >= base ? entry.ids ?? [] : [])))

// The generation params of one chat round: our defaults, then the sliding
// window's override, then whatever the caller asked for (an OpenAI request's
// temperature and seed). Until 2026-09-21 the caller's object was spread over
// the whole completion() call instead of over these defaults, so an empty
// {} from the HTTP layer replaced them all and the addon ran on its own
// (temp 0.8, predict -1): one turn of the multiquery run generated 11853
// tokens. The window's override is not optional -- a slide during generation
// invalidates the reasoning compactor's tracked span and fails the request.
// `reasoning_budget` caps the reasoning channel: the sampler force-emits
// </think> once it is spent (index.d.ts:268). It is the reliable switch --
// /no_think only damps Qwen3.5 and is no longer in either prompt. One turn of
// the 2026-09-21 mini-run spent 18386 characters on "Thanks, that is all I
// needed", hit `predict` and answered with nothing in 43 s.
export const roundParams = (asked = {}, { predict = config.chatPredict, discard = config.chatDiscard, reasoning = config.chatReasoningBudget, repeat = config.chatRepeatPenalty } = {}) =>
  ({ temp: 0.2, predict, ...(repeat > 0 ? { repeat_penalty: repeat } : {}), ...(reasoning >= 0 ? { reasoning_budget: reasoning } : {}), ...(discard > 0 ? { remove_thinking_from_context: false } : {}), ...asked })

// Cleans the model's rewrite: first line, no quotes or "Query:" prefix. Falls
// back to the original when the model wrote nothing usable.
export const cleanRewrite = (text = '', original) => {
  const line = text.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const unquote = (t) => t.replace(/^["'`«]+|["'`»]+$/g, '').trim()
  const cleaned = unquote(unquote(line).replace(/^(?:standalone |search |rewritten )*query:\s*/i, ''))
  const ok = cleaned.length >= 3 && cleaned.length <= 300 && !/<\/?think>|<tool_call>|\{"name":/i.test(cleaned)
  return { query: ok ? cleaned : original, used: ok }
}

// The conversation the rewrite sees: the last few questions with the answers
// they got, clipped. Tool rounds are skipped; their markup is not for the
// rewriter.
export const rewriteTranscript = (prior, query) => {
  const turns = []
  for (const message of prior) {
    if (message.role === 'user') turns.push({ q: rawQuery(message.content), a: '' })
    else if (message.role === 'assistant' && turns.length) turns.at(-1).a = message.content ?? ''
  }
  const recent = turns.slice(-REWRITE_TURNS)
  if (!recent.length) return null
  const lines = recent.map((t) => `User: ${t.q}\nAssistant: ${t.a.replace(/\s+/g, ' ').trim().slice(0, REWRITE_ANSWER_CHARS)}`)
  return [...lines, `User: ${query}`, '', 'Standalone search query:'].join('\n')
}

const rewriteQuery = async (runtime, prior, query) => {
  const transcript = rewriteTranscript(prior, query)
  if (!transcript) return null
  const t0 = Date.now()
  const info = { from: query, to: query, used: false, ms: 0, stats: null }
  let settle = () => {}
  try {
    const completion = await runtime.completion({
      history: [{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: transcript }],
      captureThinking: true,
      // reasoning_budget 0 switches the reasoning channel off for this call
      // alone: without it Qwen3.5-2B spends its whole budget on a "Thinking
      // Process" and writes no query (probe 2026-09-18); with it the rewrite
      // is 13 to 15 tokens in about 0.7 s.
      generationParams: { temp: 0, predict: 48, reasoning_budget: 0 },
    })
    settle = completion.settle
    const final = await completion.run.final
    const cleaned = cleanRewrite(final.contentText ?? '', query)
    Object.assign(info, { to: cleaned.query, used: cleaned.used, stats: final.stats ?? null })
  } catch (error) {
    info.error = String(error?.message ?? error)
    runtime.log?.warn?.({ err: info.error }, 'query rewrite failed; searching with the original')
  } finally {
    settle()
    info.ms = Date.now() - t0
  }
  return info
}

// messages: the conversation so far, exactly as the model saw it (a session's
// stored turns, or the client's history), ending with the new user query.
// shown: the chunk ids this session has put in front of the model, per turn
// ({ at, ids }) so a compaction can tell which are still there. session: the
// key under which the SDK keeps the KV state between calls. base: the message
// index the session's last turn recorded, the start of the excerpts the
// cached state holds. onDelta receives each content token as it is generated.
//
// Returns the answer plus everything a session has to store to replay this
// turn: the messages added (user turn with excerpts, tool rounds, the final
// answer), the chunks shown (automatic and tool-retrieved), the retrieval hits,
// the retrieval block (mode, fusion, the query searched, the rewrite) and the
// `base` this turn ran with, which the next turn passes back in.
export const answer = async (runtime, { messages, session, shown = [], base: storedBase = 0, from: storedFrom = 0, onDelta, generationParams: asked = {}, ...params }) => {
  const startedAt = Date.now()
  const query = messages.at(-1)?.role === 'user' ? messages.at(-1).content : ''
  const earlier = messages.slice(0, messages.at(-1)?.role === 'user' ? -1 : undefined).map(({ role, content }) => ({ role, content }))
  // Where the excerpts of this context start, and the history as the model
  // will see it: bare questions before the base, excerpts kept from it on.
  // The direct engine keeps no excerpt in the cached state, so its base is
  // always the end of the history: every earlier turn is replayed bare.
  // A turn window replaces the compaction: nothing earlier keeps its
  // excerpts, and the conversation itself starts at `from`.
  const plan = DIRECT
    ? { base: earlier.length, from: 0, compacted: false }
    : KEEP_TURNS > 0
      ? { base: earlier.length, from: windowStart(bareHistory(earlier), storedFrom), compacted: false }
      : compactionPlan(earlier, { base: storedBase, from: storedFrom })
  const { base, from } = plan
  const prior = DIRECT
    ? replayHistory(earlier, 'current', base)
    : KEEP_TURNS > 0
      ? replayHistory(bareHistory(earlier), 'current', bareHistory(earlier).length).slice(from)
      : replayHistory(earlier, LAYOUT, base, { dropTools: DROP_TOOL_ROUNDS }).slice(from)
  // Chunks still in front of the model; those dropped with their turn are not.
  const seen = new Set(visibleChunks(shown, base))
  const firstTurn = !prior.some((message) => message.role === 'user')

  // Hits and citations of this turn; the search tool appends to both.
  const hits = []
  const citations = []
  let retrievalMs = 0
  const toHits = (results, via) => results.slice(0, CHAT_TOPK).map((r) => {
    const id = `${r.file}::${r.chunkIndex}`
    const hit = { id, file: r.file, chunkIndex: r.chunkIndex, score: r.score, content: r.content, reused: seen.has(id) }
    return via ? { ...hit, via } : hit
  })
  // previous: the earlier user questions, for the automatic search only; a
  // search_documents call already carries a self-contained query.
  let historyText = null
  const runSearch = async (text, via, previous = null) => {
    const t0 = Date.now()
    try {
      const texts = previous ? queryTexts(text, previous) : { vectorTexts: [text], ftsTexts: [text], joined: null }
      if (texts.joined) historyText = texts.joined
      const found = toHits(await search(text, CHAT_TOPK, { embed: runtime.embed, fusion: FUSION, vectorTexts: texts.vectorTexts, ftsTexts: texts.ftsTexts }), via)
      for (const hit of found) {
        seen.add(hit.id)
        hits.push(hit)
        if (!citations.some((c) => c.file === hit.file)) citations.push({ file: hit.file, score: hit.score, ...(hit.reused ? { reused: true } : {}), ...(via ? { via } : {}) })
      }
      return found
    } catch (err) {
      // If retrieval is unavailable, fall back to a plain answer rather than failing the whole request.
      runtime.log?.error?.(err)
      return []
    } finally {
      retrievalMs += Date.now() - t0
    }
  }

  // Automatic retrieval: every turn in auto mode. In tool mode the model
  // searches for itself, first turn included, unless MERIDIAN_TOOL_FIRST_TURN
  // puts the old head start back. With rewrite on, a turn with history
  // searches for the rewritten query.
  let rewrite = null
  let searchQuery = query
  const retrieveNow = Boolean(query) && (MODE === 'auto' || (firstTurn && TOOL_FIRST_TURN))
  if (retrieveNow && REWRITE && !firstTurn) {
    rewrite = await rewriteQuery(runtime, prior, query)
    if (rewrite) searchQuery = rewrite.to
  }
  const previousQuestions = prior.filter((message) => message.role === 'user').map((message) => rawQuery(message.content))
  const autoHits = retrieveNow ? await runSearch(searchQuery, undefined, previousQuestions) : []

  // One entry per completion round: the SDK's stats and the tool calls made.
  const rounds = []
  // cache: off (no key, every turn prefilled whole), reused (the prefix the
  // SDK holds still matches) or dropped (this turn compacted and re-primed).
  // A turn window rewrites the history every turn -- the tool rounds of the
  // previous turns are dropped from the replay while the KV still holds them
  // -- and the SDK reuses a cache by message count, so the counts no longer
  // line up: measured, the cached prefix kept growing to 15553 tokens while
  // the turn sent 17 and the model answered from a state nobody had built.
  // The window trades the cache away for a small context.
  const cacheable = !DIRECT && KEEP_TURNS <= 0 && Boolean(session) && (LAYOUT !== 'current' || CTX_BUDGET > 0)
  // checkpoint: the direct engine's cached state holds the bare conversation
  // and this turn's excerpts live in a key that is thrown away after the turn.
  const trimmed = KEEP_TURNS > 0 ? from !== storedFrom : plan.compacted
  const cacheMode = DIRECT ? 'checkpoint' : !cacheable ? 'off' : (trimmed ? 'dropped' : 'reused')
  const retrieval = { mode: MODE, engine: ENGINE, fusion: FUSION, layout: DIRECT ? 'current' : LAYOUT, k: CHAT_TOPK, budget: CTX_BUDGET, ctx: config.chatCtx || null, discard: config.chatDiscard || null, base, from, keep: KEEP_TURNS || null, compacted: !DIRECT && trimmed, cache: cacheMode, query: searchQuery, rewrite, history: historyText }
  const done = (text) => ({ text, citations, messages: turn, hits, rounds, retrieval, base, from, ...summarize({ startedAt, retrievalMs, rounds, rewrite }) })

  // Tools of this request: the shared two plus, in tool mode, a search bound to
  // this turn's hits. Its result carries the fresh excerpts in full and only
  // names the files of chunks the conversation already holds.
  const tools = MODE === 'tool'
    ? [...baseTools, searchDocumentsTool({
        run: async (text) => {
          const found = await runSearch(text, 'tool')
          return {
            excerpts: found.filter((hit) => !hit.reused).map((hit) => ({ source: hit.file, text: hit.content })),
            already_in_conversation: [...new Set(found.filter((hit) => hit.reused).map((hit) => hit.file))],
          }
        },
      })]
    : baseTools
  const toolByName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

  // Messages this turn adds to the conversation, in the order the model sees them.
  const turn = [{ role: 'user', content: buildUserTurn(autoHits, query) }]
  const history = [{ role: 'system', content: SYSTEM }, ...prior, ...turn]
  // Layout current has no cached prefix worth keeping unless a budget holds
  // one: without a budget every earlier turn is rewritten, so the key is left
  // off and the turn is prefilled whole.
  const kvCache = cacheable ? kvCacheKey(session) : undefined
  // A compaction rewrites messages the cached state already holds and the
  // addon can only append to it, so the file goes: this turn re-primes the
  // system prompt and sends the clean history once.
  if (kvCache && trimmed) await runtime.deleteCache?.(kvCache)

  // The direct engine works in deltas: the checkpoint holds everything before
  // this turn, so a round sends only what the previous one appended. Without a
  // session the checkpoint is scratch and goes when the turn does.
  const engine = DIRECT ? await runtime.directChat() : null
  const sessionKey = session ?? `anon-${randomUUID()}`
  // Schemas for our own parser: the direct engine always needs them to render
  // the block, and with the declarations in the system prompt they are what
  // types the arguments read out of the model's text.
  const schemas = DIRECT || TOOLS_IN_SYSTEM ? toolSchemas(tools) : null
  let sent = 0

  const nextRound = (round) => {
    if (!DIRECT) {
      return runtime.completion({
        history,
        tools: TOOLS_IN_SYSTEM ? [] : tools,
        kvCache,
        // Reasoning models wrap their scratchpad in <think>. Captured separately it
        // stays out of contentText, so it is never read aloud or shown as an answer.
        captureThinking: true,
        generationParams: roundParams(asked),
        ...params,
      })
    }
    const prompt = turn.slice(sent)
    sent = turn.length
    return engine.completion({
      session: sessionKey,
      system: SYSTEM,
      bare: prior,
      prompt,
      resume: round > 0,
      tools: TOOLS_IN_SYSTEM ? [] : schemas,
      params: roundParams(asked, { predict: config.directPredict }),
    })
  }

  // A tool call from the SDK carries its own validated invoke; one parsed out
  // of the model's text does not, so the schema is applied here.
  const invoke = (call) => {
    if (call.invoke) return call.invoke()
    const tool = toolByName[call.name]
    if (!tool) throw new Error(`unknown tool ${call.name}`)
    return tool.handler(tool.parameters.parse(call.arguments ?? {}))
  }

  const finish = (text) => {
    if (DIRECT) engine.release(sessionKey).catch(() => {})
    if (DIRECT && !session) engine.drop(sessionKey).catch(() => {})
    return done(text)
  }

  // Agent loop: each round is one completion. A round that asks for tools gets
  // their results appended as `tool` messages and the next round starts; the
  // loop ends on the first round with no tool calls or at MAX_TOOL_ROUNDS.
  // Each tool allows maxTries calls per query; past that the model gets an
  // error instead of a result. Tools stay declared in every round: without
  // them the model still writes tool-call markup, which then streams as text.
  const tries = {}
  let lastText = ''
  for (let round = 0; ; round++) {
    const { run, settle } = await nextRound(round)

    try {
      // The SDK keeps a declared tool's call out of the delta stream. An
      // undeclared one is plain text to it, so it is filtered here or the
      // markup reaches the person reading the answer.
      // Always filtered, not only when the declarations sit in the system
      // prompt. The SDK keeps a declared tool's call out of the delta stream,
      // but it stops recognising the reasoning block from the fourth turn of
      // a cached session and those tags arrive as content (docs/todo-9.md).
      const stream = onDelta ? createMarkupFilter(onDelta) : null
      if (onDelta) for await (const event of run.events) if (event.type === 'contentDelta') stream.push(event.text)
      stream?.flush()
      const final = await run.final
      // Undeclared tools mean no parsed calls from the SDK: they are read out
      // of the text the model wrote, the same way the direct engine does it.
      const calls = TOOLS_IN_SYSTEM
        ? parseToolMarkup(final.raw?.fullText ?? final.contentText ?? '', schemas).calls
        : (await final.toolCalls) ?? []
      // thinkingChars: how much the model reasoned before answering; it costs generated tokens.
      const entry = { stats: final.stats ?? null, toolCalls: [], thinkingChars: (final.thinkingText ?? '').length }
      rounds.push(entry)
      // A block the model wrote but the loop is not acting on (the round
      // limit, or markup it emitted next to a real answer) must not reach
      // the user as text, which is what an undeclared tool risks.
      const text = stripThinking(stripToolMarkup(final.contentText ?? '')).trim()
      if (text) lastText = text
      if (calls.length === 0 || round >= MAX_TOOL_ROUNDS) {
        const answer = text || lastText || NO_ANSWER
        turn.push({ role: 'assistant', content: answer })
        // text and citations are the shape req 5.2 of the eval protocol fixes.
        return finish(answer)
      }

      const push = (message) => { history.push(message); turn.push(message) }
      push({ role: 'assistant', content: final.raw?.fullText ?? '' })
      for (const call of calls) {
        const tool = toolByName[call.name]
        tries[call.name] = (tries[call.name] ?? 0) + 1
        const t0 = Date.now()
        // A handler that throws becomes an error the model can read; the
        // request itself never fails on a tool.
        const result = !tool ? { error: `unknown tool ${call.name}` }
          : tries[call.name] > tool.maxTries ? { error: `${call.name} was already called for this question; use its earlier result` }
          : await Promise.resolve().then(() => invoke(call)).catch((error) => ({ error: `${call.name} failed: ${error?.message ?? error}` }))
        entry.toolCalls.push({ name: call.name, args: call.arguments ?? null, ms: Date.now() - t0, ...(result?.error ? { error: String(result.error) } : {}) })
        push({ role: 'tool', content: afterTool(result, round + 1 >= MAX_TOOL_ROUNDS) })
        const cite = toolCitation[call.name]
        if (cite && !citations.some((c) => c.file === cite.file)) citations.push(cite)
      }
    } finally {
      settle()
    }
  }
}
