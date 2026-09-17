import { z } from 'zod'
import { DATA_AS_OF, lookupStock } from '../../vendor/stock-tool/src/index.js'
import { listIndexedHashes } from '../rag/store.mjs'

// Tools the chat model may call. Zod schemas go to the SDK, which hands the
// model a JSON schema and validates the arguments it sends back.
export const tools = [
  {
    name: 'list_documents',
    description:
      'List every file in the document corpus, as paths relative to the corpus root. ' +
      'Call this whenever the user asks which documents, files or sources exist; retrieved passages are never the full list.',
    parameters: z.object({}),
    handler: async () => ({ files: Object.keys(await listIndexedHashes()).sort() }),
  },
  {
    name: 'lookup_stock',
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

// A fact that came from a tool is cited as the tool plus its data date.
export const toolCitation = { lookup_stock: { file: 'stock-tool', asOf: DATA_AS_OF } }
