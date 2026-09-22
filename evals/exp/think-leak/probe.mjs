#!/usr/bin/env node
// Where the stray `</think>` comes from: the SDK misclassifying a reasoning
// token as content, or the model writing a bare close into the content stream.
// Runs one session of N turns against a live serve and records, per turn, how
// many thinkingDelta and contentDelta events arrived and whether the closing
// tag showed up in the content.
//
//   node evals/exp/think-leak/probe.mjs [base] [turns]
const base = process.argv[2] ?? 'http://127.0.0.1:11435/v1'
const turns = Number(process.argv[3] ?? 8)
const session = `think-leak-${Date.now()}`

const QUESTIONS = [
  'What is the standard warranty for the ServoDrive X4?',
  'What is the enterprise P1 first-response SLA?',
  'What was the Q2 2026 logo churn percentage?',
  'What is the maximum discount an Account Executive can approve?',
  'What is the list price of the ServoDrive X4?',
  'What was the June NPS score?',
  'What is the RMA turnaround target?',
  'How many net new hires are planned for Q3?',
]

for (let i = 0; i < turns; i++) {
  const query = QUESTIONS[i % QUESTIONS.length]
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': session },
    body: JSON.stringify({ model: 'meridian-assistant', stream: true, messages: [{ role: 'user', content: query }] }),
  })
  let content = ''
  let chunks = 0
  for await (const chunk of response.body) {
    for (const line of Buffer.from(chunk).toString('utf8').split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content
      if (delta) { content += delta; chunks++ }
    }
  }
  const at = content.indexOf('</think>')
  console.log(JSON.stringify({
    turn: i + 1,
    deltas: chunks,
    chars: content.length,
    close_in_stream: at !== -1,
    chars_before_close: at === -1 ? null : at,
    head: content.slice(0, 70).replace(/\n/g, ' '),
  }))
}
