import { z } from 'zod'

// Verdict shapes, one per category, mirroring docs/todo.md "Judge: structured
// output" field for field. The reasoning fields come before the labels so
// the model writes its grounds first (G-Eval); labels are small enums, not
// scores. z.toJSONSchema feeds the SDK's responseFormat, which llama.cpp
// turns into a grammar, so the output always parses.

const Claim = z.object({
  text: z.string().describe('one atomic statement from the answer, in your own words'),
  evidence: z.string().nullable().describe('a verbatim quote from the excerpts or tool results that supports or contradicts it; null when there is none'),
  support: z.enum(['supported', 'contradicted', 'not_in_context']),
})

export const SingleVerdict = z.object({
  claims: z.array(Claim).max(8).describe('the answer split into atomic claims, at most 8'),
  answered: z.enum(['yes', 'partial', 'no', 'refused']).describe('did the answer address the question at all'),
  correct: z.enum(['yes', 'partial', 'no']).describe('does the answer agree with the reference'),
  relevance: z.enum(['on_topic', 'partly', 'off_topic']),
  notes: z.string().max(200),
})

export const AbstainVerdict = z.object({
  behaviour: z.enum(['abstained', 'answered', 'hedged_with_number', 'redirected']),
  invented_facts: z.array(z.string()).max(5).describe('facts or numbers stated that the excerpts and tool results do not contain'),
  says_why: z.boolean().describe('does the answer say the documents do not hold this'),
  next_step: z.boolean().describe('does the answer point to where the fact could be found'),
  notes: z.string().max(200),
})

const TurnVerdict = z.object({
  turn: z.number().int(),
  reference_resolved: z.enum(['yes', 'no', 'na']).describe('for elliptical turns: was the reference to an earlier turn understood'),
  consistent: z.enum(['yes', 'contradicts', 'na']),
  contradicts_turn: z.number().int().nullable(),
  notes: z.string().max(120),
})

export const MultiturnVerdict = z.object({
  turns: z.array(TurnVerdict),
  coherence: z.enum(['coherent', 'minor_slips', 'incoherent']),
  knowledge_retention: z.enum(['kept', 'partial', 'lost']),
  goal_reached: z.boolean(),
  notes: z.string().max(200),
})

export const SCHEMAS = { single: SingleVerdict, abstain: AbstainVerdict, multiturn: MultiturnVerdict }

// JSON Schema for the SDK. `strict` in the SDK does not tighten anything, so
// additionalProperties is closed here; llama.cpp's grammar keeps the keys in order.
export const jsonSchemaFor = (category) => {
  const schema = z.toJSONSchema(SCHEMAS[category], { target: 'draft-7' })
  delete schema.$schema
  return { type: 'json_schema', json_schema: { name: `${category}_verdict`, schema, strict: true } }
}

// Numbers the report derives from a verdict; the judge never states them.
export const derive = {
  single: (verdict, context) => {
    const claims = verdict.claims ?? []
    const supported = claims.filter((c) => c.support === 'supported').length
    const quoted = claims.filter((c) => c.evidence)
    const verified = quoted.filter((c) => context.includes(c.evidence.trim())).length
    return {
      faithfulness: claims.length ? supported / claims.length : null,
      hallucination: claims.some((c) => c.support === 'not_in_context' || c.support === 'contradicted'),
      evidence_verified: quoted.length ? verified / quoted.length : null,
      n_claims: claims.length,
    }
  },
  abstain: (verdict) => ({
    hallucination: (verdict.invented_facts?.length ?? 0) > 0 || verdict.behaviour === 'hedged_with_number' || verdict.behaviour === 'answered',
    abstain_ok: verdict.behaviour === 'abstained' && (verdict.invented_facts?.length ?? 0) === 0,
  }),
  multiturn: (verdict) => {
    const turns = verdict.turns ?? []
    const followups = turns.filter((t) => t.reference_resolved !== 'na')
    return {
      followup_resolution: followups.length ? followups.filter((t) => t.reference_resolved === 'yes').length / followups.length : null,
      contradictions: turns.filter((t) => t.consistent === 'contradicts').length,
    }
  },
}
