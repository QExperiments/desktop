# Eval report 2026-09-22T16-03-53-261Z

| Machine | Tier | Chat model | Runs | Cold start | Turns | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| Apple M4 Pro, 24.00 GB, metal | M | QWEN3_5_2B_MULTIMODAL_Q4_K_M | 1 | 3570 ms | 410 | 0 |

## Latency (all live turns)

| ttft p50 | ttft p95 | tps p50 | total p50 | total p95 | prefill tps p50 | cache ratio | prompt tokens | completion tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1382 ms | 1876 ms | 97.9 | 4367 ms | 10344 ms | 1282 | 0.47 | 5974 | 265 |

## Retrieval

| k (chunks) | recall@k | precision@k | hit@k |
| --- | --- | --- | --- |
| 1 | 56% | 87% | 87% |
| 3 | 89% | 58% | 99% |
| 4 | 93% | 48% | 99% |
| 5 | 96% | 42% | 99% |
| 7 | 98% | 32% | 99% |
| 10 | 98% | 25% | 99% |

133 queries, MRR 0.96, retrieval ms p50 10 ms. Each row is its own search(query, k): k counts fused chunks, what the chat would show the model with CHAT_TOPK = k (today 3); recall is the share of the gold files among them.

## Single

| n | must | number match | grounded | citation precision | lang | empty | leak | false abstain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 100% | 100% | 100% | 51% | 100% | 0% | 0% | 0% |

## Abstain

| n | abstained | tool called | grounded | by kind | abstention precision | abstention recall |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 90% | 20% | 100% | {"out_of_corpus":{"n":4,"abstained_rate":1},"future":{"n":3,"abstained_rate":1},"near_miss":{"n":3,"abstained_rate":0.667}} | 100% | 90% |

## Tools

| n | routing P | routing R | tp/wrong/fp/fn/tn | args match | wrong tool | must | rounds | repeat calls | limit hits | tool errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 11 | 100% | 57% | 4/0/0/3/4 | 25% | 0% | 73% | 1.36 | 0 | 0 | 0 |

## Memory

| sessions | recalls | memory overall | from memory | re-fetched | by d |
| --- | --- | --- | --- | --- | --- |
| 8 | 24 | 96% | 92% | 4% | d=1: 88% (8), d=3: 100% (8), d=6: 100% (8) |

## Multiturn

| sessions | followup resolution | consistency | must | routing P | routing R |
| --- | --- | --- | --- | --- | --- |
| 8 | 84% | 100% | 92% | 88% | 88% |

## Multiquery

| turns | n | recall@5 | precision@5 | hit@5 | MRR | evidence in context | context recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all with gold | 74 | 94% | 49% | 100% | 0.96 | 100% | 96% |
| standalone | 40 | 95% | 53% | 100% | 0.99 | 100% | 95% |
| follow-up | 34 | 92% | 44% | 100% | 0.93 | 100% | 98% |

9 sessions, 83 turns; hits are what the chat showed the model (search(query, 5)), recall is the share of the gold files among them, evidence in context counts gold shown earlier in the session too. Refusal-expected turns: 9, abstained (code) 67%.

## Stress

| session | turns | errors | empty | ttft p50/p95 | tps p50 | ttft slope ms/turn | rss peak | rss slope B/s | ctx hit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stress-01 r1 | 13 | 0% | 0% | 744 ms / 1540 ms | 96.6 | 21.4 | 2.08 GB | -299591 | none |
| stress-02 r1 | 14 | 0% | 0% | 353 ms / 1530 ms | 93.6 | -41.2 | 2.10 GB | -533265 | none |

## Hardware by phase

| phase | samples | rss tree peak | rss bare peak | footprint bare peak | cpu % | gpu % |
| --- | --- | --- | --- | --- | --- | --- |
| before_load | 14 | n/a | n/a | n/a | n/a | 6 |
| loaded_idle | 8 | 2.31 GB | 2.20 GB | 0.68 GB | 2 | 2 |
| generating | 3642 | 2.38 GB | 2.23 GB | 0.79 GB | 249 | 91 |
| after_generation | 6 | 2.00 GB | 1.91 GB | 0.75 GB | 41 | 15 |
| after_unload | 9 | n/a | n/a | n/a | 0 | 0 |

rss tree = node + bare worker, weights included (what the app needs in RAM); footprint bare = KV cache, buffers and runtime without the mmap'd weights (what Activity Monitor shows).
