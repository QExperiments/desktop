import { loadModel, unloadModel, embed } from '@qvac/sdk'
import { config, getEmbeddingModelSrc, query } from './store.mjs'

let cachedModelId = null
let cachedSource = null

// Loads the embedding model once and reuses it across queries, reloading only when the source changes.
async function ensureModel() {
  const source = getEmbeddingModelSrc()
  if (cachedModelId && cachedSource?.modelSrc === source.modelSrc) return cachedModelId
  if (cachedModelId) await unloadModel({ modelId: cachedModelId })
  cachedModelId = await loadModel({
    modelSrc: source.modelSrc,
    modelType: source.modelType,
    modelConfig: config.embeddingModelConfig,
  })
  cachedSource = source
  return cachedModelId
}

// Unloads the cached model so it can be freed, for example before the process exits.
export async function releaseModel() {
  if (cachedModelId) {
    await unloadModel({ modelId: cachedModelId })
    cachedModelId = null
    cachedSource = null
  }
}

// Embeds the query and runs hybrid search, dropping results without a usable score.
export async function search(queryText, topK = config.topK) {
  const modelId = await ensureModel()
  const { embedding } = await embed({ modelId, text: queryText })
  const results = await query(queryText, embedding, topK)
  return results.filter((r) => r.score !== undefined)
}

// Evaluation queries used to measure recall against a fixed set of expected documents.
const evalQueries = [
  { query: 'What is the watchlist threshold and which accounts are below it as of 30 June 2026?', doc_id: 'data/account-health-q2-close.json' },
  { query: 'What is the Q2 logo churn percentage and company NPS?', doc_id: 'data/account-health-q2-close.json' },
  { query: 'What is the unweighted open pipeline for APAC as of 30 June 2026?', doc_id: 'data/regional-pipeline-snapshot.csv' },
  { query: 'What was total Q2 revenue and the Q3 revenue plan in the pipeline snapshot?', doc_id: 'data/regional-pipeline-snapshot.csv' },
  { query: 'What is the list price of the ControLink Gateway rev C per unit?', doc_id: 'data/sku-list-prices.csv' },
  { query: 'What is the list price of the ServoDrive X4?', doc_id: 'data/sku-list-prices.csv' },
  { query: 'What is the P1 first-response SLA and the internal L1 to L2 clock?', doc_id: 'policies/escalation-matrix.txt' },
  { query: 'What is the P2 first-response SLA?', doc_id: 'policies/escalation-matrix.txt' },
  { query: 'How often must the offline knowledge pack refresh and when does it warn of stale data?', doc_id: 'policies/field-service-offline-sop.md' },
  { query: 'What is the standard warranty duration for ServoDrive X4?', doc_id: 'policies/warranty-terms.md' },
  { query: 'What is the RMA turnaround target after receipt?', doc_id: 'policies/warranty-terms.md' },
  { query: 'What is the enterprise P1 first-response SLA per the internal FAQ?', doc_id: 'faqs/support-sla-faq.html' },
  { query: 'Can I promise a ControLink Gateway rev C next week?', doc_id: 'faqs/support-sla-faq.html' },
  { query: 'Which competitor displaced NovaPack EU and for how much ARR?', doc_id: 'faqs/competitor-displacement-notes.md' },
  { query: 'What is the discount authority ceiling for a VP Enterprise Sales?', doc_id: 'faqs/competitor-displacement-notes.md' },
  { query: 'What is the Atlas Manufacturing contracted ARR and when was it closed?', doc_id: 'emails/001-atlas-deal-closed.md' },
  { query: 'What is the Atlas opportunity ID?', doc_id: 'emails/001-atlas-deal-closed.md' },
  { query: 'What is the incremental ARR for the Pinnacle Foods expansion and its effective date?', doc_id: 'emails/002-pinnacle-expansion.md' },
  { query: 'What is Pinnacle Foods new total ARR after the expansion?', doc_id: 'emails/002-pinnacle-expansion.md' },
  { query: 'What is the locked Q3 2026 revenue forecast?', doc_id: 'emails/003-q3-forecast-lock.md' },
  { query: 'What is the Q3 new ARR bookings target?', doc_id: 'emails/003-q3-forecast-lock.md' },
  { query: 'How many net new hires are approved for Q3 and how many are Account Executives?', doc_id: 'emails/004-hiring-plan.md' },
  { query: 'What is the current headcount in FTEs?', doc_id: 'emails/004-hiring-plan.md' },
  { query: 'What was the Q2 logo churn percentage?', doc_id: 'emails/005-churn-alert.md' },
  { query: 'Which two accounts are on the Q3 watchlist with health below 40?', doc_id: 'emails/005-churn-alert.md' },
  { query: 'What was the June NPS score and how many respondents?', doc_id: 'emails/006-nps-pulse.md' },
  { query: 'What is the NPS target by the end of Q3?', doc_id: 'emails/006-nps-pulse.md' },
  { query: 'What is the enterprise P1 first-response SLA per the reminder email?', doc_id: 'emails/007-sla-reminder.md' },
  { query: 'What is the P2 workaround or restore target?', doc_id: 'emails/007-sla-reminder.md' },
  { query: 'What is the Q2 field defect rate and which SKU has the highest defect rate?', doc_id: 'emails/008-quality-board.md' },
  { query: 'How long is the outgoing burn-in after CAPA-441 containment?', doc_id: 'emails/008-quality-board.md' },
  { query: 'What stage is the Helix Robotics deal in and what is its ARR?', doc_id: 'emails/009-helix-demo-complete.md' },
  { query: 'When is the Helix Robotics decision expected?', doc_id: 'emails/009-helix-demo-complete.md' },
  { query: 'When is the Riverton Motors EBR scheduled?', doc_id: 'emails/010-riverton-ebr-scheduled.md' },
  { query: 'What is the Riverton Motors health score?', doc_id: 'emails/010-riverton-ebr-scheduled.md' },
  { query: 'What is the standard spare-parts lead time for APAC?', doc_id: 'emails/011-spare-parts-lead-time.md' },
  { query: 'What is the expedite surcharge for air shipping spare parts?', doc_id: 'emails/011-spare-parts-lead-time.md' },
  { query: 'What is the target average time-to-first-productive-line by 30 September?', doc_id: 'emails/012-onboarding-remediation.md' },
  { query: 'How many CSMs are in the dedicated onboarding squad?', doc_id: 'emails/012-onboarding-remediation.md' },
  { query: 'What is the H2 FY2026 list price for ControLink Suite per seat?', doc_id: 'emails/013-list-pricing-update.md' },
  { query: 'What is the list price of the predictive maintenance module?', doc_id: 'emails/013-list-pricing-update.md' },
  { query: 'What is the maximum discount an Account Executive can give?', doc_id: 'emails/014-discount-authority.md' },
  { query: 'Who approves discounts above 20 percent?', doc_id: 'emails/014-discount-authority.md' },
  { query: 'What is the Atlas Cincinnati go-live target date?', doc_id: 'emails/015-atlas-kickoff-complete.md' },
  { query: 'What is the Atlas implementation services amount?', doc_id: 'emails/015-atlas-kickoff-complete.md' },
  { query: 'Before which date can rev C not be promised without Ops approval?', doc_id: 'emails/016-capa-441-ship-hold.md' },
  { query: 'What is the list price for ControLink Gateway rev C per the ship-hold note?', doc_id: 'emails/016-capa-441-ship-hold.md' },
  { query: 'What is the list price and defect rate of ServoDrive X4?', doc_id: 'reports/fy2026-product-catalog-excerpt.md' },
  { query: 'What is the multi-site package discount for ControLink Suite?', doc_id: 'reports/fy2026-product-catalog-excerpt.md' },
  { query: 'What was the Q1 2026 total recognized revenue?', doc_id: 'reports/q1-2026-sales-summary.md' },
  { query: 'What was the Q1 logo churn?', doc_id: 'reports/q1-2026-sales-summary.md' },
  { query: 'What was the Q2 2026 total recognized revenue and the beat against target?', doc_id: 'reports/q2-2026-sales-performance-report.md' },
  { query: 'What is the Q2 win rate and average enterprise sales cycle?', doc_id: 'reports/q2-2026-sales-performance-report.md' },
  { query: 'What is the pipeline coverage into Q3 against the 4.2M target?', doc_id: 'transcripts/call-2026-06-18-q2-pipeline-review.md' },
  { query: 'What action items were agreed at the 18 June pipeline review?', doc_id: 'transcripts/call-2026-06-18-q2-pipeline-review.md' },
  { query: 'What did Lena steer the Helix team toward for any July need?', doc_id: 'transcripts/call-2026-06-26-helix-tech-validation.md' },
  { query: 'What discount ceiling reminder was given on the Helix call?', doc_id: 'transcripts/call-2026-06-26-helix-tech-validation.md' },
  { query: 'What is the published spare-parts lead time for Americas and EMEA?', doc_id: 'transcripts/call-2026-07-02-field-ops-standup.md' },
  { query: 'What is the Atlas Cincinnati go-live target per the field ops standup?', doc_id: 'transcripts/call-2026-07-02-field-ops-standup.md' },
]

// Runs the evaluation queries and reports, for every k, both recall@k (did the
// expected file rank inside the top-k) and precision@k (how many of the top-k
// chunks actually belong to the expected file). Missed references are listed at
// k=5 when it is one of the requested values.
export async function evalRecall(kList = [3, 5, 10]) {
  const maxK = Math.max(...kList)
  const perQuery = []
  const sums = kList.map(() => ({ recall: 0, precision: 0 }))

  for (const item of evalQueries) {
    const results = await search(item.query, maxK)
    const files = results.slice(0, maxK).map((r) => r.file)
    const rank = files.indexOf(item.doc_id)
    const row = {
      query: item.query,
      doc_id: item.doc_id,
      rank,
      top: files.slice(0, 10),
      k: {},
    }

    kList.forEach((k, i) => {
      const hit = rank !== -1 && rank < k
      const relevant = files.slice(0, k).filter((f) => f === item.doc_id).length
      row.k[k] = {
        recall: hit ? 1 : 0,
        precision: Number((relevant / k).toFixed(4)),
      }
      sums[i].recall += row.k[k].recall
      sums[i].precision += row.k[k].precision
    })

    perQuery.push(row)
  }

  const n = evalQueries.length
  const report = {
    queries: n,
    k: {},
  }
  kList.forEach((k, i) => {
    report.k[k] = {
      recall: Number((sums[i].recall / n).toFixed(4)),
      precision: Number((sums[i].precision / n).toFixed(4)),
    }
  })
  report.missesAt5 = kList.includes(5)
    ? perQuery.filter((r) => r.k[5].recall === 0).map((r) => r.doc_id)
    : []

  const metrics = kList.map((k) => `recall@${k}=${report.k[k].recall} precision@${k}=${report.k[k].precision}`).join(' ')
  console.log(`\nEval - ${n} queries | ${metrics}\n`)
  perQuery.forEach((r, i) => {
    const pos = r.rank === -1 ? 'NOT-FOUND' : `rank=${r.rank + 1}`
    const parts = kList.map((k) => `r${k}=${r.k[k].recall}/p${k}=${r.k[k].precision}`).join(' ')
    console.log(`${String(i + 1).padStart(2)}. ${pos} | ${parts} | ref=${r.doc_id}`)
    console.log(`    q: ${r.query}`)
    console.log(`    top: ${r.top.join(', ')}`)
    console.log()
  })
  return { report, perQuery }
}