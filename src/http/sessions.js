import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Same alphabet the KV-cache key allows, so one id names both.
const VALID = /^[\w.-]{1,64}$/

// A session is named only by the client's `x-session-id` header. OpenAI's
// `user` field is an end-user identifier for monitoring, not a conversation
// key: a stock client that sets it and sends its full `messages` must stay in
// stateless Chat Completions mode, so the server never reads it.
export const isSessionId = (id) => typeof id === 'string' && VALID.test(id)

// One JSON file per session under data/sessions. It stays on this disk next
// to the corpus index; the chat page reads it back to show earlier chats, and
// the chat route reads it back as the model's history.
//
// A turn stores two views of itself. `query` and `answer` are what the person
// saw. `messages` are what the model saw: the user turn with its document
// excerpts, tool calls, tool results, the final answer. The SDK's KV cache
// keeps count of the messages it has stored under the session key and sends
// only the tail, so the replayed history has to match the original message
// for message. `shown` lists the chunk ids the turn put in front of the model.
export const createSessions = (dir) => {
  const queues = new Map()
  const turns = new Map()
  const file = (id) => join(dir, `${id}.json`)

  const read = async (id) => {
    try {
      return JSON.parse(await readFile(file(id), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  // Reads and writes of one session run in order, so a read queued after a
  // write sees it.
  const serial = (id, task) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(task, task)
    queues.set(id, next.catch(() => {}))
    return next
  }

  // One turn of a session at a time, from reading its history to saving the
  // answer. Two turns at once -- a text and a voice turn, or a client that
  // retries -- would both replay the same history into one KV cache and then
  // save their messages in an order the cache never saw. Resolves to the
  // release function; a turn that never calls it blocks the session.
  const lock = async (id) => {
    const previous = turns.get(id) ?? Promise.resolve()
    let release
    const held = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => held)
    turns.set(id, tail)
    await previous
    return () => {
      release()
      if (turns.get(id) === tail) turns.delete(id)
    }
  }

  const get = async (id) => (VALID.test(String(id)) ? read(id) : null)

  const append = (id, turn) => {
    if (!VALID.test(String(id))) return Promise.resolve(null)
    return serial(id, async () => {
      await mkdir(dir, { recursive: true })
      const now = new Date().toISOString()
      const session = (await read(id)) ?? { id, title: String(turn.query ?? '').slice(0, 80), createdAt: now, turns: [] }
      session.turns.push({ at: now, ...turn })
      session.updatedAt = now
      // A reader never meets half a file: the new one is renamed over the old.
      const temp = `${file(id)}.tmp`
      await writeFile(temp, JSON.stringify(session))
      await rename(temp, file(id))
      return session
    })
  }

  const list = async () => {
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'))
    const sessions = await Promise.all(names.map((name) => read(name.slice(0, -5))))
    return sessions
      .filter(Boolean)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(({ id, title, createdAt, updatedAt, turns }) => ({ id, title, createdAt, updatedAt, turns: turns.length }))
  }

  // The model's view of a session: every message its turns added, in order,
  // the chunks already shown with the message index of the turn that showed
  // them, and the `base` of the last turn (src/chat/answer.js: where the
  // excerpts the cached state holds begin). A turn written before messages
  // were stored is replayed as the plain question and answer.
  const context = (id) => serial(id, async () => {
    const turns = (await get(id))?.turns ?? []
    const messages = []
    const shown = []
    let base = 0
    let from = 0
    for (const turn of turns) {
      const at = messages.length
      messages.push(...(turn.messages ?? [
        { role: 'user', content: turn.query ?? turn.question ?? '' },
        { role: 'assistant', content: turn.answer ?? '' },
      ]))
      if (turn.shown?.length) shown.push({ at, ids: turn.shown })
      if (Number.isFinite(turn.base)) base = turn.base
      if (Number.isFinite(turn.from)) from = turn.from
    }
    return { messages, shown, base, from }
  })

  const history = async (id) => (await context(id)).messages

  // Forgets a chat: the file goes and the id is free again. False when there
  // was nothing to delete. The KV-cache file is the runtime's to drop.
  const remove = (id) => {
    if (!VALID.test(String(id))) return Promise.resolve(false)
    return serial(id, () => rm(file(id)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    }))
  }

  return { get, append, list, context, history, remove, lock }
}
