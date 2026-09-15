import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import contract from '../qvac-eval.json' with { type: 'json' }
import qvac from '../qvac.config.json' with { type: 'json' }

const abs = (rel) => fileURLToPath(new URL(rel, new URL('../', import.meta.url)))
const base = new URL(contract.baseUrl)

export const config = {
  host: base.hostname,
  port: Number(base.port),
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
  pidPath: abs('data/serve.pid'),
  importDir: process.env.MERIDIAN_MODELS_DIR ?? '',
  tierOverride: process.env.MERIDIAN_TIER?.toUpperCase() ?? '',
  logContent: process.env.LOG_CONTENT === '1',
}
