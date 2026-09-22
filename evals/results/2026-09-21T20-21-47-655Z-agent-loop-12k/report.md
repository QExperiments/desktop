# Eval report 2026-09-21T20-21-47-655Z

| Machine | Tier | Chat model | Runs | Cold start | Turns | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| Apple M4 Pro, 24.00 GB, metal | M | QWEN3_5_2B_MULTIMODAL_Q4_K_M | 1 | 3548 ms | 18 | 0 |

## Latency (all live turns)

| ttft p50 | ttft p95 | tps p50 | total p50 | total p95 | prefill tps p50 | cache ratio | prompt tokens | completion tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1607 ms | 2066 ms | 103.9 | 6490 ms | 43304 ms | 1466 | 0.47 | 6020 | 670 |

## Hardware by phase

| phase | samples | rss tree peak | rss bare peak | footprint bare peak | cpu % | gpu % |
| --- | --- | --- | --- | --- | --- | --- |
| before_load | 14 | n/a | n/a | n/a | n/a | 5 |
| loaded_idle | 8 | 2.18 GB | 2.08 GB | 0.58 GB | 1 | 5 |
| generating | 316 | 2.25 GB | 2.11 GB | 0.69 GB | 238 | 96 |
| after_generation | 5 | 1.98 GB | 1.85 GB | 0.65 GB | 43 | 19 |
| after_unload | 9 | n/a | n/a | n/a | 0 | 2 |

rss tree = node + bare worker, weights included (what the app needs in RAM); footprint bare = KV cache, buffers and runtime without the mmap'd weights (what Activity Monitor shows).
