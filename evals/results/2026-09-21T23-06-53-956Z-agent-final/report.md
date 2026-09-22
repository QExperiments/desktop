# Eval report 2026-09-21T23-06-53-956Z

| Machine | Tier | Chat model | Runs | Cold start | Turns | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| Apple M4 Pro, 24.00 GB, metal | M | QWEN3_5_2B_MULTIMODAL_Q4_K_M | 1 | 3541 ms | 133 | 0 |

## Latency (all live turns)

| ttft p50 | ttft p95 | tps p50 | total p50 | total p95 | prefill tps p50 | cache ratio | prompt tokens | completion tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 422 ms | 478 ms | 101.0 | 5829 ms | 9242 ms | 1417 | 0.34 | 3729 | 338 |

## Hardware by phase

| phase | samples | rss tree peak | rss bare peak | footprint bare peak | cpu % | gpu % |
| --- | --- | --- | --- | --- | --- | --- |
| before_load | 14 | n/a | n/a | n/a | n/a | 6 |
| loaded_idle | 8 | 2.20 GB | 2.09 GB | 0.76 GB | 1 | 4 |
| generating | 1617 | 2.24 GB | 2.12 GB | 0.80 GB | 241 | 92 |
| after_generation | 5 | 2.14 GB | 1.89 GB | 0.67 GB | 85 | 15 |
| after_unload | 9 | n/a | n/a | n/a | 0 | 2 |

rss tree = node + bare worker, weights included (what the app needs in RAM); footprint bare = KV cache, buffers and runtime without the mmap'd weights (what Activity Monitor shows).
