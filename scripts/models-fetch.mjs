import fs from 'node:fs'
import path from 'node:path'
import {
  loadModel,
  unloadModel,
  embed,
  close,
  EMBEDDINGGEMMA_300M_Q4_0,
  modelRegistrySearch,
  modelRegistryList,
  getSystemResources,
} from '@qvac/sdk'
import { config } from '../src/rag/store.mjs'

function pickDevice(resources) {
  return resources?.gpu ? 'gpu' : 'cpu'
}

async function main() {
  console.log('Meridian - model fetch\n')

  console.log('Listing embedding models from the QVAC registry...')
  const all = await modelRegistryList()
  console.log(`Registry knows ${all.length} model(s)`)
  const embeds = await modelRegistrySearch({ engine: 'llamacpp-embedding' })
  console.log(`${embeds.length} embedding model(s) found (engine=llamacpp-embedding)`)
  for (const m of embeds.slice(0, 8)) {
    const size = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)}GB` : `${(n / 1e6).toFixed(0)}MB`)
    console.log(`   - ${m.name}  (${m.quantization ?? 'n/a'}, ${size(m.expected_size || 0)})`)
  }
  console.log()

  const resources = await getSystemResources()
  const device = pickDevice(resources)
  console.log(`Device: ${device} (${resources?.gpu ? 'GPU/Vulkan' : 'CPU only'})`)

  console.log(`\nDownloading ${config.embeddingModelId} into ${config.modelsDir}...`)
  const modelId = await loadModel({
    modelSrc: EMBEDDINGGEMMA_300M_Q4_0,
    modelConfig: config.embeddingModelConfig,
    onProgress: (p) => {
      const mb = (n) => (n / 1e6).toFixed(1)
      process.stderr.write(`\rDownloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`)
      if (p.percentage >= 100) process.stderr.write('\n')
    },
  })

  try {
    const { embedding } = await embed({ modelId, text: 'probe' })
    const dimension = embedding.length
    console.log(`Embedding dimension: ${dimension}`)
  } finally {
    await unloadModel({ modelId })
    await close()
  }

  const gguf = fs
    .readdirSync(config.modelsDir)
    .filter((f) => f.toLowerCase().endsWith('.gguf'))
    .map((f) => path.join(config.modelsDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]

  if (!gguf) {
    throw new Error(`No .gguf found in ${config.modelsDir} after download`)
  }

  const manifest = {
    modelId: config.embeddingModelId,
    quantization: 'Q4_0',
    file: gguf,
    dimension: 0,
    updatedAt: new Date().toISOString(),
  }

  console.log(`\nVerifying local load from ${path.basename(gguf)}...`)
  const localModelId = await loadModel({ modelSrc: gguf, modelType: 'llamacpp-embedding', modelConfig: config.embeddingModelConfig })
  try {
    const { embedding } = await embed({ modelId: localModelId, text: 'probe' })
    manifest.dimension = embedding.length
    console.log(`Local load OK, dimension ${manifest.dimension}`)
  } finally {
    await unloadModel({ modelId: localModelId })
    await close()
  }

  fs.mkdirSync(path.dirname(config.manifestFile), { recursive: true })
  fs.writeFileSync(config.manifestFile, JSON.stringify(manifest, null, 2))
  console.log(`\nManifest written to ${config.manifestFile}`)
  console.log('Next: npm run corpus:ingest')
}

main().catch((err) => {
  console.error('Model fetch failed:', err)
  process.exit(1)
})