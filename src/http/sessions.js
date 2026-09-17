import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Same alphabet the KV-cache key allows, so one id names both.
const VALID = /^[\w.-]{1,64}$/

// One JSON file per session under data/sessions. It stays on this disk next
// to the corpus index; the chat page reads it back to show earlier chats.
export const createSessions = (dir) => {
  const queues = new Map()
  const file = (id) => join(dir, `${id}.json`)

  const read = async (id) => {
    try {
      return JSON.parse(await readFile(file(id), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  // Writes to one session run in order: a voice turn and a text turn can land together.
  const serial = (id, task) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(task, task)
    queues.set(id, next.catch(() => {}))
    return next
  }

  const get = async (id) => (VALID.test(String(id)) ? read(id) : null)

  const append = (id, turn) => {
    if (!VALID.test(String(id))) return Promise.resolve(null)
    return serial(id, async () => {
      await mkdir(dir, { recursive: true })
      const now = new Date().toISOString()
      const session = (await read(id)) ?? { id, title: String(turn.question ?? '').slice(0, 80), createdAt: now, turns: [] }
      session.turns.push({ at: now, ...turn })
      session.updatedAt = now
      await writeFile(file(id), JSON.stringify(session))
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

  // The stored turns as chat history, for a route that gets no history from its client.
  const history = async (id) =>
    ((await get(id))?.turns ?? []).flatMap((turn) => [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ])

  return { get, append, list, history }
}
