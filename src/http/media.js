import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pcmToWav } from '../audio/wav.js'
import { answer } from '../chat/answer.js'
import { config } from '../config.js'
import { isSessionId } from './sessions.js'

const SAMPLE_RATE = 24_000

// Uploads go to a private temp file, are handed to the SDK by path and deleted
// straight after. Audio and photos never land in the project tree or the logs.
const withUpload = async (upload, use) => {
  const dir = await mkdtemp(join(tmpdir(), 'meridian-'))
  const path = join(dir, upload.filename || randomUUID())
  await writeFile(path, await upload.toBuffer())
  try {
    return await use(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const field = (upload, name, fallback) => upload.fields?.[name]?.value ?? fallback

const badSession = (reply) =>
  reply.code(400).send({ error: { message: 'session must be 1 to 64 characters of letters, digits, _ . or -', type: 'invalid_request_error' } })

export const registerMedia = (app, runtime, sessions) => {
  const api = config.apiPrefix

  const upload = async (request, reply) => {
    const part = await request.file().catch(() => null)
    if (part) return part
    reply.code(400).send({ error: { message: 'send the file as multipart form field `file`', type: 'invalid_request_error' } })
    return null
  }

  // 4.1.1 — one-shot transcription, OpenAI-shaped so a stock client works.
  app.post(`${api}/audio/transcriptions`, async (request, reply) => {
    const part = await upload(request, reply)
    if (!part) return reply
    const text = await withUpload(part, (path) => runtime.transcribe(path))
    return { text: String(text).trim() }
  })

  app.post(`${api}/audio/speech`, async (request, reply) => {
    const { input, language, voice } = request.body ?? {}
    if (!input) return reply.code(400).send({ error: { message: '`input` is required', type: 'invalid_request_error' } })
    const pcm = await runtime.speak(input, { ...(language && { language }), ...(voice && { voice }) })
    return reply.type('audio/wav').send(pcmToWav(pcm, SAMPLE_RATE))
  })

  // 4.2 — the hands-free loop in one call: spoken question in, answer out,
  // spoken back. Gloves stay on.
  app.post(`${api}/audio/ask`, async (request, reply) => {
    const part = await upload(request, reply)
    if (!part) return reply
    // Multipart fields must precede the file to be readable here.
    const language = field(part, 'language', 'en')
    const session = field(part, 'session', '')
    // The id names a file on disk and a KV-cache key, so it is checked like x-session-id.
    if (session && !isSessionId(session)) return badSession(reply)
    const query = String(await withUpload(part, (path) => runtime.transcribe(path))).trim()
    if (!query) return reply.code(400).send({ error: { message: 'no speech recognised in the recording', type: 'invalid_request_error' } })
    // One turn of the session at a time, as on the chat route (sessions.lock).
    const unlock = session ? await sessions.lock(session) : null
    let spoken
    try {
      // No client history on this route: earlier turns of the session come
      // from the store, with the compaction's base and window start so the
      // replay lines up with the KV cache the text turns left.
      const stored = session ? await sessions.context(session) : { messages: [], shown: [], base: 0, from: 0 }
      spoken = await answer(runtime, { messages: [...stored.messages, { role: 'user', content: query }], shown: stored.shown, base: stored.base, from: stored.from, session: session || undefined })
      if (session) {
        const shown = spoken.hits.filter((hit) => !hit.reused).map((hit) => hit.id)
        await sessions.append(session, { kind: 'voice', query, answer: spoken.text, citations: spoken.citations, messages: spoken.messages, shown, base: spoken.base, from: spoken.from })
      }
    } finally {
      unlock?.()
    }
    const pcm = await runtime.speak(spoken.text, { language })

    return {
      session: session || null,
      query,
      answer: spoken.text,
      citations: spoken.citations,
      audio: { format: 'wav', sampleRate: SAMPLE_RATE, base64: pcmToWav(pcm, SAMPLE_RATE).toString('base64') },
    }
  })

  // 4.3 — a photo of a nameplate or a broken part, asked about in words.
  app.post(`${api}/images/ask`, async (request, reply) => {
    const part = await upload(request, reply)
    if (!part) return reply
    const query = field(part, 'query', 'Describe this image in one sentence.')
    const session = field(part, 'session', '')
    if (session && !isSessionId(session)) return badSession(reply)
    // A small preview the chat page made, so an earlier chat can show the photo again.
    const thumb = field(part, 'thumb', '')
    // Qwen3.5 thinks before it answers; captured separately, the scratchpad stays out of the reply.
    const text = await withUpload(part, (path) => runtime.look({ prompt: query, imagePath: path, captureThinking: true }))
    const answer = String(text).trim()
    if (session) {
      // The chat model never saw the photo; its history gets the question and
      // answer as plain text, appended between turns rather than inside one.
      const unlock = await sessions.lock(session)
      try {
        await sessions.append(session, {
          kind: 'image', query, answer, citations: [],
          messages: [{ role: 'user', content: query }, { role: 'assistant', content: answer }], shown: [],
          ...(thumb.startsWith('data:image/') && thumb.length <= 200_000 ? { thumb } : {}),
        })
      } finally {
        unlock()
      }
    }
    return { session: session || null, query, answer }
  })
}
