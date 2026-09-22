# Eval report 2026-09-21T23-04-35-645Z

| Machine | Tier | Chat model | Runs | Cold start | Turns | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| ?, n/a, ? | M | ? | 1 | n/a | 0 | 0 |

## Latency (all live turns)

| ttft p50 | ttft p95 | tps p50 | total p50 | total p95 | prefill tps p50 | cache ratio | prompt tokens | completion tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

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

## Hardware by phase

| phase | samples | rss tree peak | rss bare peak | footprint bare peak | cpu % | gpu % |
| --- | --- | --- | --- | --- | --- | --- |

rss tree = node + bare worker, weights included (what the app needs in RAM); footprint bare = KV cache, buffers and runtime without the mmap'd weights (what Activity Monitor shows).
