import { fileURLToPath } from 'node:url'
import contract from '../qvac-eval.json' with { type: 'json' }

const abs = (rel) => fileURLToPath(new URL(rel, new URL('../', import.meta.url)))
const base = new URL(contract.baseUrl)

// Must be set before @qvac/sdk is first imported: it is how the SDK is told
// where to cache weights. Import this module before the SDK anywhere.
process.env.QVAC_CACHE_DIR ||= abs('data/models')

export const config = {
  host: base.hostname,
  port: Number(base.port),
  apiPrefix: base.pathname.replace(/\/$/, ''),
  readyTimeoutSec: contract.readyTimeoutSec,
  chatModel: contract.models.chat,
  embeddingModel: contract.models.embedding,
  modelsDir: abs('data/models'),
  manifestPath: abs('data/models/manifest.json'),
  pidPath: abs('data/serve.pid'),
  importDir: process.env.MERIDIAN_MODELS_DIR ?? '',
  tierOverride: process.env.MERIDIAN_TIER?.toUpperCase() ?? '',
  logContent: process.env.LOG_CONTENT === '1',
}
