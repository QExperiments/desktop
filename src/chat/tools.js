import { z } from 'zod'
import { DATA_AS_OF, lookupStock } from '../../vendor/stock-tool/src/index.js'
import { listIndexedHashes } from '../rag/store.mjs'

// Tools the chat model may call. Zod schemas go to the SDK, which hands the
// model a JSON schema and validates the arguments it sends back. maxTries is
// ours: how many calls one question may make to the tool before the loop in
// answer.js stops running it and tells the model to answer from what it has.
export const tools = [
  {
    name: 'list_documents',
    maxTries: 1,
    description:
      'List every file in the document corpus, as paths relative to the corpus root. ' +
      'Call this whenever the user asks which documents, files or sources exist; retrieved passages are never the full list.',
    parameters: z.object({}),
    handler: async () => ({ files: Object.keys(await listIndexedHashes()).sort() }),
  },
  {
    name: 'lookup_stock',
    maxTries: 2, // a second call with other arguments (another region, the exact SKU) is legitimate
    description:
      `Meridian inventory as of ${DATA_AS_OF}: on-hand, allocated, available units, lead time and status per SKU and region. ` +
      'Returns structured records only. An unknown SKU returns no matches plus suggestions; never invent stock or prices.',
    parameters: z.object({
      sku: z.string().optional().describe('Exact SKU code such as SD-X4-001. For a product name use query instead.'),
      query: z.string().optional().describe('Free-text search against name or product line'),
      region: z.enum(['Americas', 'EMEA', 'APAC']).optional(),
      includeDiscontinued: z.boolean().optional(),
    }),
    // Presentation is ours: keep the fields a field engineer quotes, so 25 rows
    // stay well inside the chat model's context.
    handler: async (args) => {
      const { asOf, matchCount, truncated, matches, suggestions } = lookupStock(args)
      const rows = matches.map(({ sku, name, region, available, leadTimeDays, status, replacedBy, unitListPrice }) =>
        ({ sku, name, region, available, leadTimeDays, status, replacedBy, unitListPrice }))
      return { asOf, matchCount, truncated, matches: rows, suggestions }
    },
  },
]

// What the direct engine hands the addon: the same tools, with their Zod
// schemas rendered as JSON Schema. The SDK does this itself; going straight to
// the addon we do it here.
export const toolSchemas = (list) => list.map(({ name, description, parameters }) =>
  ({ name, description, parameters: z.toJSONSchema(parameters) }))

// The tool block as the model's own chat template would render it, for
// MERIDIAN_TOOLS_IN_SYSTEM=1: the declarations move into the system prompt,
// which the addon primes once and the sliding window never evicts, instead of
// travelling with every turn (docs/todo-6.md). The hermes shape is the one
// Qwen3.5 emits calls in, so it is the one it is shown.
export const renderToolBlock = (list) => [
  '# Tools',
  'You may call one or more functions. You are given function signatures inside <tools></tools>:',
  '<tools>',
  ...toolSchemas(list).map((tool) => JSON.stringify({ type: 'function', function: tool })),
  '</tools>',
  'To call a function, emit one <tool_call> block per call:',
  '<tool_call>{"name": <function-name>, "arguments": <args-json-object>}</tool_call>',
].join('\n')

// A fact that came from a tool is cited as the tool plus its data date.
export const toolCitation = { lookup_stock: { file: 'stock-tool', asOf: DATA_AS_OF } }

// Only in MERIDIAN_RETRIEVAL_MODE=tool (ADR-012): after the first turn the
// model asks for excerpts itself. `run(query)` is the caller's search, bound to
// the request so the chunks it returns join that turn's hits and citations.
export const SEARCH_DOCUMENTS = {
  name: 'search_documents',
  maxTries: 2, // a second call with another wording is legitimate; past that, answer from what is shown
  description:
    'Search the company documents (policies, SLAs, prices, warranty terms, deals, reports, emails, call notes) for facts that are not in the conversation yet. ' +
    'Pass one self-contained query that names the product, customer, policy or metric. Returns the best matching excerpts with their source files. Never holds stock quantities.',
  parameters: z.object({
    query: z.string().describe('Self-contained search query, such as "extended warranty duration ServoDrive X4"'),
  }),
}

export const searchDocumentsTool = ({ run }) => ({ ...SEARCH_DOCUMENTS, handler: ({ query }) => run(query) })
