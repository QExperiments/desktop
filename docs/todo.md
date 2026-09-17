# TODO

Зафиксировано 2026-09-17, выполнено 2026-09-18 (ветки `N-10-keep-kv-cache-across-turns` и
`N-11-add-eval-harness`, локально). Продуктовые правки, потом eval-харнесс.
Claude-симуляции вынесены в [eval-sim-plan.md](eval-sim-plan.md) и пока не делаются.

## Продукт

### Решено, делать

- [x] **Сначала: не ломать KV-cache.** Сейчас контекст ретривала подшивается в system
      prompt, а SDK кладёт hash(system prompt + tools) в имя KV-файла и сравнивает историю
      под ключом. Итог: новый файл и полный prefill каждый ход (78 файлов, 2.9 GB на dev-Mac).
      Делать: system prompt статичный; ретрив по последнему `query`, результат идёт в
      последнее user-сообщение (`context + query`), не в system. Чанки, уже показанные в этой
      сессии, не повторяем: сессия хранит `shown` chunk ids по ходам. При `session` сервер
      берёт у клиента только последний `query`, а историю восстанавливает из
      `data/sessions/<id>.json` ровно в том виде, в каком её видела модель (иначе префикс не
      совпадёт и кэш не сработает). Без `session` кэшируется только префикс system + tools.
      Проверка: `cached_tokens` на ходе 2 ≈ `prompt_tokens` хода 1; один файл в
      `~/.qvac/kv-cache/<key>/`.
- [x] **`question` → `query`.** Везде. `answer(runtime, { messages, session })`:
      query это последний элемент `messages`, ретривал берёт его оттуда.
      `media.js` собирает `messages` из `sessions.history(session) + query`.
      Убрать раздельные `prior + question`. Делается вместе с пунктом выше.
- [x] **Статистика на каждый запрос, всегда.** Из `completionStats` каждого раунда плюс
      таймеры сервера. В ответе в формате OpenAI: `usage: { prompt_tokens, completion_tokens,
      total_tokens, prompt_tokens_details: { cached_tokens } }` и наше `stats`
      (ниже, в Evals «Всегда»). В лог только эти числа, без текста.
- [x] **KV-файлы: `deleteCache`, когда сессий > 5.** Сами `data/sessions/<id>.json`
      остаются. Сейчас на dev-Mac 78 файлов, 2.9 GB, ничего не чистит.
      Добавить `~/.qvac/kv-cache` в таблицу README «что пишется на диск».
- [x] **Пол по памяти.** `selectTier` опускает тир до S, но ниже S проверки нет:
      `serve` падает на аллокации или уходит в своп. Нужна проверка минимума и
      понятное сообщение «needs at least N GB».
- [x] **Трейсы для eval.** Сервер пишет трейс только при заголовке `x-eval-run: <ts>`
      в `data/traces/<run>/<requestId>.json`; `requestId` уезжает в последнем
      SSE-чанке. Обычные запросы ничего не пишут.
- [x] **Лог SDK печатает prompt.** Плагин `llamacpp-completion` пишет весь prompt
      (system + контекст корпуса) в лог сервера. README обещает, что prompts не
      логируются. Либо приглушить уровень лога SDK, либо поправить README.
- [x] **`setup` не распаковывает `corpus.zip`.** В `qvac-eval.json` шаг
      `corpus:ingest` ждёт `data/corpus`, а unzip делается руками.
- [x] **Исключение из handler тула** не ловится → 500. Обернуть в `{ error }`.
- [x] **Модели тиров на Qwen3.5** (решено 2026-09-18). S → `QWEN3_5_0_8B_MULTIMODAL_Q8_0`
      0.81 GB + `MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0` 0.12 GB, vision S тот же файл, SmolVLM2 убрать.
      L → `QWEN3_5_4B_MULTIMODAL_Q4_K_M` для чата, тот же файл, что vision L. M без изменений.
      Проверено на 0.8B через живой `serve` как тир S: GGUF даёт те же 24 слоя, 6 attention,
      2 KV-головы, что у 2B, то есть 12 KB/token (8k = 96 MB); загрузка 1.2 s; 8 тул-диалогов,
      0/8 пустых, `lookup_stock` и `list_documents` вызываются, отказ на FOO-999 честный. Минус:
      в одном ответе смешал lead time из корпуса (12 дней) и из тула (5 дней), это готовый
      eval-кейс для категории tools. README: снять «тулы только с M». Смена `models.json`
      отдельной веткой; sha256 и https-зеркало (unsloth/Qwen3.5-0.8B-GGUF) заполнить при fetch.
- [x] **Контекст: S 8k / M 16k / L 32k** (решено 2026-09-18). Память с запасом на всех тирах после смены
      моделей (пункт выше). Веса включают EmbeddingGemma 0.33.

      | Тир, ctx | Машина, бюджет GB | Веса | KV+state | Итого | Остаётся |
      | --- | --- | --- | --- | --- | --- |
      | S 8k, Qwen3.5-0.8B Q8_0 | 6 GB RAM, 2.7 | 1.14 | 0.11 | 1.6 | 1.1 |
      | M 16k | 8 GB, 4.8 | 1.53 | 0.23 | 2.4 | 2.4 |
      | L 32k, Qwen3.5-4B | 12 GB, 9.1 | 2.9 | 1.05 | 4.8 | 4.3 |

      Остаток съедают: vision на M (~0.7), ASR/TTS в окне 5 минут (~0.2–0.4),
      compute-буфер без flash-attn (~0.27 на M при 16k), всё сверх резерва ОС 3.5 GiB.

- [x] **Один embedder.** `src/rag/retrieve.mjs` сам вызывает `loadModel` для EmbeddingGemma, а
      runtime держит ту же модель в роли `embed`: две копии по 0.33 GB в одном `serve`.
      `search(query, k, { embed })` берёт `runtime.embed`; свой `loadModel` остаётся только
      для CLI `corpus:ingest`, где runtime нет.

### Отложено / идеи

- [ ] Каталог моделей (реестр + локальные, подсветка по бюджету). Решение: только
      CLI `models:list --refresh` + один `GET /v1/models/catalog`, без скачивания
      из сервера. Идея отложена.
- [ ] UI вне установщика: флаг + dynamic import + esbuild external, ~6 строк.
- [ ] Эндпоинт удаления сессии (вопрос для Raj).
- [ ] Установщик: запуск на Bare вместо требования Node 22; сборка без голоса
      (минус аддоны asr + tts, примерно треть от 72 MB); zip.
- [ ] Альтернативные chat-модели для M. Gemma 4 отпала: в реестре E2B Q4_K_M весит 3.46 GB
      (per-layer embeddings в файле), E4B 5.41 GB, в бюджет M на 8 GB не входит. LFM2.5-2.6B в
      реестре нет. Остаётся сравнение квантов Qwen3.5-2B и Qwen3.5-9B как «XL» для ≥ 16 GB.

## Evals (`evals/` в корне)

### Структура папки

```
evals/
  config.json               минимум параметров, см. ниже
  run.mjs                   `npm run eval`: один вход, фазы в схеме ниже;
                            флаги --tier M --only tools,memory --runs 3 --no-judge --report-only <ts>
  lib/
    cases.mjs               грузит cases/*.jsonl, валидирует по схеме категории, раскладывает case × run
    server.mjs              spawn `serve` с PORT и MERIDIAN_TIER, ждёт 200 на /v1/models, stop; cold_start_ms
    client.mjs              POST /v1/chat/completions, SSE, x-eval-run, x-session-id; requestId из последнего чанка
    sampler.mjs             `ps -o rss,%cpu` по дереву node + bare и `vm_stat` каждые 0.5 с; метки фаз и ходов
    traces.mjs              читает data/traces/<run>/<requestId>.json
    metrics/
      retrieval.mjs         recall@k, precision@k, MRR, hit@1
      text.mjs              must, number_match, grounded, citation_precision, lang, empty, leak, abstained
      tools.mjs             routing P/R, args_subset_match, wrong_tool, rounds, repeat_calls, limit_hits, tool stats
      memory.mjs            memory@d, recalled_from_memory / re_fetched
      multiturn.mjs         followup_resolution, consistency
      stress.mjs            p50/p95, тренды по ходам, memory_slope, ctx_hit_turn
    judge/
      judge.mjs             loadModel(config.judge) → на строку: prompt из .md + responseFormat json_schema → verdict
      schemas.mjs           Zod: SingleVerdict, AbstainVerdict, MultiturnVerdict; z.toJSONSchema → SDK
      prompts/
        single.md           плейсхолдеры {query} {answer} {context} {tool_results} {reference}
        abstain.md
        multiturn.md        весь транскрипт + контексты ходов, один вызов на кейс
    report/
      build.mjs             turns + verdicts + hardware → один report.html (данные инлайном, без CDN) + report.md
      template.html
  cases/
    retrieval.jsonl single.jsonl abstain.jsonl tools.jsonl memory.jsonl multiturn.jsonl stress.jsonl
    labels/                 10–15 строк с ручной разметкой (answered/correct/hallucination) для калибровки judge
  results/<ts>/             turns.jsonl traces/ hardware.jsonl verdicts.jsonl metrics.json report.html report.md  (.gitignore)
  README.md                 как гонять, определения метрик, допущения
```

В сервере: `src/http/trace.js` пишет трейс при `x-eval-run`, иначе ничего.

`config.json`, минимум:

```json
{
  "port": 11435,
  "runs": 3,
  "sampleMs": 500,
  "tiers": ["M"],
  "models": { "S": null, "M": null, "L": "Qwen3.5-4B-Q4_K_M" },
  "judge": { "model": "Qwen3.5-9B-Q4_K_M", "batch": 4, "ctx": 8192, "temp": 0 },
  "judgeCategories": ["single"]
}
```

`models.<tier>: null` значит «как в `models.json`»; строка переопределяет chat-модель тира на этот
прогон (сравнить кванты Qwen3.5-2B на M, не трогая продукт). Judge это другая, более крупная
модель, чем кандидат. Решено: по умолчанию `Qwen3.5-9B-Q4_K_M` (5.7 GB). 27B
(`Qwen3.8-27B-UD-Q4_K_XL`, 17.9 GB) только по флагу `--judge <model>` на свободном Mac: он в
3 раза медленнее, а 2-bit вариант не даёт ни скорости (prefill упирается в compute), ни
качества. Judge идёт отдельной фазой после `server.stop()`. Сначала judge только по single: abstain и
multiturn включаются в `judgeCategories` вручную, когда будут реальные цифры по времени.

Judge батчами: SDK даёт `batchCompletion({ modelId, prompts: [...] })`, у каждого prompt своя
`history` и `responseFormat`. Берём по `judge.batch` строк (4) за вызов: decode упирается в память,
поэтому четыре последовательности идут почти по цене одной, prefill не ускоряется. Rubric и
инструкции лежат в одном system prompt для всех строк, поэтому с `kvCache` ключом их префикс
(~700 tokens) считается один раз. Проверить, как SDK делит `ctx` между prompts батча.
Оценка на dev-Mac для 9B: ~17 s на verdict последовательно, ~10 s в батче с кэшем префикса,
180 verdict'ов ≈ 30 мин против 1.5–2 ч на 27B.

### Flow

```
npm run eval -- --tier M
 │
 ├─ cases.load(config)            план case × run
 ├─ sampler.start()               фаза 1 before_load: только system_used, процесса ещё нет
 ├─ server.start(tier) → 200      фаза 2 loaded_idle; cold_start_ms
 ├─ retrieval.jsonl               search(query, k) in-process, serve не участвует → metrics/retrieval
 ├─ для каждого case × run  (single, abstain, tools, memory, multiturn, stress)
 │     session = <ts>-<case.id>-<n>
 │     для каждого хода
 │        messages = история (live: реальные ответы; golden: эталонные) + query
 │        client.ask(messages, session, x-eval-run)       фаза 3 generating, метка хода в sampler
 │        ← text, citations, requestId, ttft клиента, wall_ms
 │        trace = traces.read(requestId)                   hits, rounds[].{tool_calls, stats}, retrieval_ms, tool_ms
 │        turns.jsonl ← case, run, turn, text, поля трейса, метрики кодом (lib/metrics/*)
 │     фаза 4 after_generation: метка после последнего хода кейса
 ├─ server.stop()                 фаза 5 after_unload; sampler.stop() → hardware.jsonl
 ├─ judge (кроме --no-judge)      loadModel(judge) только теперь, память serve уже свободна
 │     строки категорий из judgeCategories (пока single) по judge.batch за раз: batchCompletion(prompts/<cat>.md + schemas) → verdicts.jsonl
 │     unloadModel
 ├─ metrics.json                  агрегаты по категориям, p50/p95, P/R, доли judge, kappa на cases/labels
 └─ report/build                  results/<ts>/report.html + report.md
```

Judge никогда не работает одновременно с `serve`: иначе замеры памяти фаз 2–4 ничего не значат.

### Всегда, на каждый запрос (by default)

Пишутся в трейс, в `usage`/`stats` ответа и одной строкой в лог сервера; без eval-заголовка
трейс не пишется, а `usage`/`stats` и лог остаются.

| Поле | Откуда |
| --- | --- |
| prompt_tokens, completion_tokens, cached_tokens, cache_ratio = cached / prompt | `completionStats` (сумма по раундам) |
| ttft_ms, tps | `completionStats` первого раунда / последнего раунда |
| total_ms, retrieval_ms, tool_ms | таймеры сервера: от входа запроса до последнего токена |
| rounds, tool_calls (имя, args, ms, error) | цикл в `answer.js` |
| tree_rss_peak node + bare за запрос, cpu_percent | семплер раннера, тик 0.5 с, сумма по дереву, срез между метками запроса. macOS и Linux: `ps -axo pid,ppid,rss,%cpu`; Windows: PowerShell `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process` (WorkingSet, PercentProcessorTime, один запрос). В продовом `stats` только снимок rss node + bare на конец запроса |
| system_used_delta | до и после запроса. macOS `vm_stat` (active + wired + compressed), Linux `MemTotal − MemAvailable`, Windows `Win32_OperatingSystem` (TotalVisibleMemorySize − FreePhysicalMemory). Шумит от соседних приложений, поэтому рядом с tree_rss, а не вместо |
| gpu_util | macOS `ioreg -r -d 1 -c IOAccelerator` → «Device Utilization %», без sudo (проверено); Windows `typeperf "\GPU Engine(*)\Utilization Percentage"`, встроен; Linux sysfs `gpu_busy_percent` (amdgpu), у Intel iGPU встроенного источника нет → null |
| prefill_tps = (prompt_tokens − cached_tokens) / ttft_s | из `completionStats`; показывает, что даёт KV-cache отдельно от decode |

Не берём by default: swap_used, phys_footprint, power/thermal (`--gpu`), ctx_fill (считается в
score из prompt_tokens и ctx), kv_cache_dir_bytes, load_avg.

Сложность реализации: метрики собираются на всех платформах (fleet это Windows), но без
отдельной большой реализации под ОС. Семплер это один интерфейс `sample()` и три адаптера
(darwin, linux, win32) по 15–25 строк: одна команда ОС на тик плюс regex. Нет встроенного
источника у конкретной платформы (GPU на Intel Linux) → поле `null`, ничего не ставим. Из npm
ничего нового: `zod` для схем judge, `@qvac/sdk` для judge и `search` уже в проекте. График в
отчёте один: SVG polyline памяти по фазам, ~20 строк; всё остальное таблицы.

### Данные

Сценарии, не транскрипты: каждый прогон заново проигрывает реплики против живого `serve`.
Режим `live` подставляет реальные ответы в историю, режим `golden` эталонные (изолирует ход).
Judge это локальная модель побольше, корпус не покидает машину.

Объём: ~10 кейсов на категорию (70 строк). Для stress «10 кейсов» это 10–15 запросов одной
сессии, таких сценариев 1–2. Кейсы пишет subagent (sonnet) по схемам категорий и корпусу
`data/corpus`, потом ручная проверка `gold_doc_ids`, `reference` и `must`. Общее для каждого кейса: `id`, `tags` (`tier:M`, `lang:en`), `runs`
(повторы против недетерминизма, по умолчанию из config). Каждый ход хранит `stats` из
`completionStats` и `requestId` трейса.

| # | Файл | Вход | Обработка | Метрики кодом | Метрики judge |
| --- | --- | --- | --- | --- | --- |
| 1 | retrieval | `query`, `gold_doc_ids`, `k` (по умолчанию 3) | без LLM: прямой вызов `search(query, k)`, дёшево | recall@k, precision@k, MRR, hit@1, retrieval_ms | нет |
| 2 | single | `query`, `gold_doc_ids`, `reference` (эталон одной фразой), `must` regex | полный путь через `serve`; трейс даёт hits и stats | must, number_match, citation_precision, grounded, lang, leak, empty | claims → faithfulness, answered, correct vs `reference`, relevance |
| 3 | abstain | `query`, `kind`: out_of_corpus / future / near_miss (P4, когда есть только P1–P3) | как 2; вместе с 2 даёт abstain precision/recall (ложные отказы на single, ложные ответы на abstain) | abstained (regex отказа), tool not called, grounded=false | behaviour, invented_facts → hallucination, says_why, next_step |
| 4 | tools | `messages` (история), эталон: `tool` name или null, `args` только значимые, `must` | трейс: `rounds[].tool_calls` | routing precision/recall по всему набору, args_subset_match, wrong_tool, rounds, repeat_calls, limit_hits, число из результата тула попало в ответ | не нужен |
| 5 | memory | `turns` ~10, `fact_turn`, `recall_turns` с `must`; d считается сам | одна сессия, live prior | memory@d для d = 1, 3, 5, …, recalled_from_memory vs re_fetched, prompt_tokens по ходам, статистика тулов | нет |
| 6 | multiturn | `turns` с per-turn expect как в 2 + 4, флаг `followup` на эллиптических ходах, `consistency` пары | режимы live / golden | всё из 2 и 4 по ходам, followup_resolution, consistency, статистика тулов | turns[].reference_resolved / consistent, coherence, knowledge_retention, goal_reached |
| 7 | stress | 20–30 `queries` в одной сессии (сэмпл из 2 и 4), expect нет | одна сессия, семплер памяти с метками ходов | empty_rate, error_rate (5xx, таймауты), TTFT и TPS p50/p95 и тренд по ходам, cached_tokens по ходам, max memory, memory_slope ≈ 0 внутри прогона, пик равен между прогонами ± допуск, ctx_hit_turn и что тогда: 500 или обрезание, статистика тулов | нет |

Статистика тулов (5–7): вызовов на ход и на тул, доля ходов с тулом, rounds, repeat_calls,
limit_hits, tool_ms, tool_errors.

Память в нашей системе это только контекст модели, без summary, поэтому d в memory ограничен ctx.

Убрано: `switch_contamination` (кандидат на потом), `model_load_ms` (покрыт `cold_start_ms`),
`kv_disk_bytes`, `kv_files` (нужны только для проверки `deleteCache`), `≤3 предложения`, `no_numbers`
(judge покрывает через `invented_facts`).

### Метрики кодом: определения

| Метрика | Что считает | Пример |
| --- | --- | --- |
| must | хотя бы один regex/строка из списка найден в ответе | `must: ["6 weeks", "six weeks"]`; «Lead time is six weeks.» → pass |
| number_match | доля чисел из `reference`, найденных в ответе после нормализации (1,200 → 1200, 6.0 → 6); числа словами кладём в `must` | reference «MOQ 500, lead time 6 weeks»; «MOQ is 500 units, ships in 6 weeks» → 2/2; «MOQ 5000, 6 weeks» → 1/2 |
| grounded | все числа ответа встречаются в показанных чанках или результате тула | чанк «MOQ 500»; ответ «MOQ 500» → true; «MOQ 600» → false |
| citation_precision | cited ∩ gold / cited по файлам; на нашем коде это precision@k по файлам, потому что citations = hits (+ `stock-tool`); остаётся как контроль проводки | cited [a, b, c], gold [a] → 1/3 |
| lang | язык ответа совпадает с языком `query` (эвристика по алфавиту ru / latin, для en-de словарик) | query по-русски, ответ по-английски → fail |
| empty | `text.trim() === ''` | ответ только `<tool_call>` без текста → true |
| leak | служебное в тексте: `<think>`, `<tool_call>`, `{"name":`, `/no_think`, «You are Meridian», `[1] source:` | ответ начинается с `<tool_call>{"name":"lookup_stock"` → true |
| abstained | regex отказа: «not in the corpus», «don't have», «нет данных», … Факт отказа; нужен ли он, задаёт категория (abstain ждёт true, single false) → precision/recall отказов | «The corpus does not state the MOQ for P4.» → true |
| routing P/R | по всему набору tools: TP = ждали тул и вызван он же; P = TP / все вызовы, R = TP / все ожидания | 12 ждут `lookup_stock`, 8 ждут null; вызван на 11 из 12 и на 2 из 8 → P 11/13, R 11/12 |
| args_subset_match | значимые `args` кейса ⊆ args вызова | ждём `{sku:"MC-1042"}`; вызов `{sku:"MC-1042", region:"EU"}` → true; `{sku:"MC-1042-B"}` → false |
| wrong_tool | вызван не тот тул или неизвестное имя | «what is in stock for MC-1042» → `list_documents` → true |
| rounds | число completion-раундов на query: 1 без тулов, 2 нормальный тул-кейс, максимум MAX_TOOL_ROUNDS + 1 | тул → ответ = 2 |
| repeat_calls | повтор того же тула с теми же args в одном query | `lookup_stock({sku:"MC-1042"})` дважды → 1 |
| limit_hits | сколько раз вернулась ошибка `maxTries` | `lookup_stock` третий раз → 1 |
| memory@d | доля recall-ходов, прошедших `must`, по d = recall_turn − fact_turn | факт на ходе 2, вспоминаем на 3, 5, 7 → d = 1, 3, 5 |
| recalled_from_memory | recall-ход прошёл `must`, rounds = 1 и факт не пришёл новым hit → взят из контекста | ход 2: тул → «120 pcs»; ход 7 «remind me the EU stock» → «120» без тула → true |
| re_fetched | `must` прошёл, но тул вызван снова или чанк с фактом пришёл ретривалом заново; правильно, но стоит раунд и говорит, что история не читается | ход 7 снова `lookup_stock` → «120» → true |
| followup_resolution | ход с `followup: true` (эллипсис) прошёл свой `must` | T1 «MOQ MC-1042?» → 500; T2 «а срок поставки?» `must /week/` → «6 weeks» pass; «which product?» fail |
| consistency | пара ходов `[i, j]` про один факт разными словами даёт одни и те же числа | T1 → 500; T5 «minimum order quantity for the MC-1042 connector» → 500 ok; 400 fail |
| ctx_hit_turn | первый ход stress, где prompt_tokens ≥ ctx − predict; рядом что случилось: 500, обрезание, пустой ответ | ctx 4096: ход 5 |

### Judge: structured output

Опора: RAGAS (faithfulness = поддержанные утверждения / все утверждения, answer relevancy),
TruLens RAG triad (context relevance, groundedness, answer relevance), DeepEval (Faithfulness,
Hallucination, Knowledge Retention, Conversation Completeness), G-Eval (сначала рассуждение,
потом метка). Поправки под локальный 27B: метки бинарные или тернарные, не 1–10; разбор по
утверждениям; `evidence` дословной цитатой, которую код проверяет как подстроку контекста
(`evidence_verified`), это ловит выдумки самого judge; поле с обоснованием стоит в схеме раньше
метки; `temp: 0`; выход через `responseFormat: { type: 'json_schema' }` (SDK 0.18.2
конвертирует в GBNF; с `tools` не совмещается, judge тулы не нужны). Judge видит query или
транскрипт, ответ, показанные чанки из трейса, результаты тулов, `reference`. Не видит `<think>`
кандидата. Калибровка: `cases/labels/` размечаем руками, отчёт печатает согласие judge с
разметкой (Cohen's kappa); ниже 0.6 правим промпт.

Примеры verdict'ов. Zod-схемы в `evals/lib/judge/schemas.mjs` повторяют их один в один,
комментарий у поля перечисляет допустимые значения.

```jsonc
// 2 single. Вход judge: query, answer, показанные чанки, результаты тулов, reference.
// query: "What is the standard warranty for the ServoDrive X4 and what does it cost?"
// answer: "The X4 has a standard 24-month warranty and lists at $48,500 per unit. An extended 36-month warranty is available."
{
  "claims": [                                                        // ответ разбит на атомарные утверждения, не больше 8
    {
      "text": "Standard warranty is 24 months",                      // одно утверждение из ответа, своими словами
      "evidence": "Standard warranty for ServoDrive X4 is 24 months.", // дословная цитата из чанка или результата тула; null, если её нет
      "support": "supported"                                         // supported | contradicted | not_in_context
    },
    {
      "text": "List price is $48,500 per unit",
      "evidence": "SD-X4-001,ServoDrive X4,A,48500,per unit",
      "support": "supported"
    },
    {
      "text": "An extended 36-month warranty is available",
      "evidence": null,
      "support": "not_in_context"                                    // в контексте нет → это и есть выдумка
    }
  ],
  "answered": "yes",                                                 // yes | partial | no | refused: ответила ли на вопрос вообще
  "correct": "partial",                                              // yes | partial | no: сравнение с reference кейса
  "relevance": "on_topic",                                           // on_topic | partly | off_topic: про то ли, что спросили
  "notes": "Warranty and price match the documents; the 36-month extension is not in them." // до 200 символов, идёт в отчёт
}
// кодом: faithfulness = 2/3 = 0.67; hallucination = true (есть not_in_context);
// evidence_verified = 2/2 (обе цитаты найдены в контексте как подстроки)

// 3 abstain. kind: near_miss (в корпусе есть X4, спрашивают про X5).
// query: "What is the standard warranty for the ServoDrive X5?"
// answer: "The ServoDrive X5 most likely carries the same 24-month warranty as the X4 line."
{
  "behaviour": "hedged_with_number",                                 // abstained | answered | hedged_with_number | redirected
  "invented_facts": ["ServoDrive X5 has a 24-month warranty"],       // факты и числа, которых нет в контексте, не больше 5
  "says_why": false,                                                 // сказала ли, что в документах этого нет
  "next_step": false,                                                // предложила ли, где узнать: lookup_stock, sales desk
  "notes": "Transfers the X4 warranty to a product the corpus never mentions."
}
// кодом: hallucination = true (invented_facts > 0 и hedged_with_number); abstain_ok = false.
// Хороший ответ здесь: behaviour "abstained", invented_facts [], says_why true, next_step true.

// 6 multiturn. Один вызов на кейс: весь транскрипт плюс контексты ходов.
// T1 "List price of the ServoDrive X4?" → "$48,500 per unit."
// T2 "And the warranty?" (followup) → "The X4 comes with a 24-month standard warranty."
// T3 "How many are in stock in EMEA?" → lookup_stock → "12 units in EMEA."
// T4 "Remind me the unit price of the X4." (consistency pair with T1) → "$45,800 per unit."
{
  "turns": [                                                         // по одному объекту на ход ассистента
    {
      "turn": 1,                                                     // номер хода, как в кейсе
      "reference_resolved": "na",                                    // yes | no | na: для ходов с followup, понята ли отсылка
      "consistent": "na",                                            // yes | contradicts | na: не расходится ли с ранними ходами
      "contradicts_turn": null,                                      // номер хода, которому противоречит; иначе null
      "notes": ""                                                    // до 120 символов
    },
    { "turn": 2, "reference_resolved": "yes", "consistent": "na", "contradicts_turn": null, "notes": "'the warranty' read as X4" },
    { "turn": 3, "reference_resolved": "na", "consistent": "na", "contradicts_turn": null, "notes": "" },
    { "turn": 4, "reference_resolved": "yes", "consistent": "contradicts", "contradicts_turn": 1, "notes": "45,800 vs 48,500 on turn 1" }
  ],
  "coherence": "minor_slips",                                        // coherent | minor_slips | incoherent: читается ли как один разговор
  "knowledge_retention": "partial",                                  // kept | partial | lost: помнит ли факты своих ранних ходов
  "goal_reached": true,                                              // получил ли пользователь всё, за чем пришёл
  "notes": "Price drifted on turn 4; references and tool routing fine."
}
// кодом: followup_resolution = 2/2; contradictions = 1; распределения coherence / retention по набору
```

Агрегаты judge в отчёте: faithfulness средняя и доля строк с hallucination (2), abstain_ok и
hallucination (3), доля разрешённых отсылок, доля противоречий, coherence / retention
распределения (6), kappa на labels.

### Железо: что и откуда

| Метрика | Источник |
| --- | --- |
| ttft_ms, tps, prompt/generated/cache tokens, backendDevice | SDK `completionStats` на каждый раунд → `trace.rounds[].stats` |
| retrieval_ms, tool_ms, total_ms | таймеры сервера, в трейсе |
| wall_ms, время до первого чанка | таймеры раннера |
| cold_start_ms | раннер: от spawn `serve` до первого 200 на `/v1/models` |
| tree_rss по фазам, пик | дерево node + bare каждые 0.5 с: macOS и Linux `ps -axo pid,ppid,rss,%cpu`, Windows `Win32_PerfFormattedData_PerfProc_Process` |
| system_used по фазам | macOS `vm_stat`, Linux `/proc/meminfo`, Windows `Win32_OperatingSystem`; `os.freemem()` не годится, не видит mmap-веса |
| kv_ram_estimate | ctx × KB/token: S 112, M 12 (+9 MB state), L 32 или 144 |
| disk: models, lancedb, sessions | `du`, один раз |
| cpu_percent | колонка того же `ps`, на Windows PercentProcessorTime; на Linux `ps %cpu` это среднее за жизнь процесса, там только ориентир |
| шапка отчёта | SDK `getSystemResources`: cpu, ядра P/E, RAM total, GPU, unifiedMemory, драйверы |
| gpu_util | by default: macOS `ioreg`, Windows `typeperf`, Linux sysfs `gpu_busy_percent` где есть, иначе null |
| gpu_power_w, thermal | только опция `--gpu` и только macOS `powermetrics` (sudo); ничего не ставим |

Фазы замера, обязательные: до загрузки модели (только `system_used`, процесса ещё нет),
после загрузки без генерации, во время генерации, после генерации, после выгрузки
(`serve:stop`, `system_used` должен вернуться к базе).

Модели работают в дочернем процессе `bare`, не в node: node 40 MB, bare 455 MB в простое
и 600 MB в запросе при 1.5 GB весов. RSS недосчитывает mmap-веса, поэтому две колонки.

### Порядок работ

0. [x] Продукт: KV-cache (статичный system, контекст в user-сообщении, история из сессии),
   `query`, `usage`/`stats` в ответе.
1. [x] Трейсы в сервере и `requestId` в SSE (`x-request-id` и `id` каждого чанка).
2. [x] `config.json`, `run.mjs` + `lib/`, 62 кейса (subagent sonnet, проверены руками), семплер памяти.
3. [x] `metrics/*`, `report/`, `npm run eval`.
4. [x] memory, multiturn, stress.
5. [x] Judge по single: schemas, prompts, kappa в отчёте. `cases/labels/` заполняется по ответам
   конкретного прогона (строка label несёт `answer_prefix`), пока пусто.
6. Голос и картинки не делаем сейчас.

### Результаты прогона 2026-09-18 (tier M, 2 прогона, 358 ходов, 0 ошибок)

Отчёт: `evals/results/2026-09-17T22-21-25-575Z/report.html` (в .gitignore). Головные числа:
TTFT p50 637 ms, ответ целиком p50 1.8 s / p95 8.7 s (хвост это thinking); retrieval recall@3 73%,
MRR 0.79 (промахи на Q2-отчёте: retrieval-04, -05); single `must` 100%, judge faithfulness 97%,
hallucination 10%, kappa с ручной разметкой: answered 1.0, correct 0.46, hallucination 0.77;
abstain 90% (precision/recall отказов 90/90); tools routing precision 100%, recall 88%, args 64%,
`must` 63%; memory@d 88/94/94% для d = 1/3/6, всё из контекста, ни одного повторного вызова тула;
multiturn followup 87%, consistency 100%; stress: контекст растёт с 3k до 11k за 13 ходов при
16k, ctx не упёрся, 1 пустой ответ из 54; память: +0.83 GB system после загрузки, rss дерева
2.3 GB, после выгрузки ниже базы.

Что вылезло и просится в следующий слайс:

- **Пустой ответ на пределе раундов**: stress-02 t11 сделал три `lookup_stock` и на четвёртом
  раунде не написал текста. Добавить финальный раунд без тулов или явный текст «не смог».
- **Аргументы тула**: модель кладёт название в `sku` («ServoDrive X4») или использует `query`
  вместо `sku`, и для SD-X4-HE берёт SD-X4-001. Описание параметров тула и пример в system prompt.
- **Q2-отчёт не находится** на вопросы про Q2 revenue и churn+NPS: Q1-summary с той же фразой
  ранжируется выше. Смотреть чанкинг 4.4 KB отчёта и вес FTS.
- **Thinking живёт в KV**: контекст сессии растёт на 0.6–1k токенов за ход; проверить
  `remove_thinking_from_context` в generationParams.
- **Judge мягче человека по `correct`** (kappa 0.46): ставит `yes` там, где ответ верен, но
  добавляет неподтверждённое (приписал цитату не тому человеку, «указано в SOW»). Ужесточить
  правило partial в `prompts/single.md`.

### Найдено при выполнении (2026-09-18)

- **Thinking и тулы.** `/no_think` в system prompt Qwen3.5 не выключает рассуждение: 600–8000
  символов `<think>` почти на каждом ходу, однажды 16k. `reasoning_budget: 0` в `modelConfig`
  выключает его (генерация в 2 раза быстрее), но 2B тогда перестаёт вызывать `lookup_stock`
  (1 из 6 стоковых вопросов против 5–8 из 8 с thinking). Любой другой бюджет аддон не соблюдает.
  Оставлено thinking. Кандидаты: `remove_thinking_from_context`, чтобы scratchpad не занимал
  KV сессии; сравнить на 4B.
- **`predict` не ограничивает генерацию**: при `predict: 320` бывало 1805 токенов (thinking).
  Проверить `predict` в `modelConfig` при загрузке.
- **Семантика `completionStats`**: `promptTokens` это обработанные токены, `cacheTokens` то, что
  пришло из кэша; в `usage.prompt_tokens` идёт сумма. На ходе 2 сессии `prefill_tokens` 15,
  TTFT 45 ms против 935 ms.
- **Judge**: с thinking у 9B ломается грамматика `responseFormat` («empty grammar stack»);
  `reasoning_budget: 0` при загрузке judge чинит. `batchCompletion` требует `parallel ≥ 2` при
  загрузке и на Metal медленнее (14.4 s/verdict в батче 4 против 10.7 s по одному), поэтому
  `batch: 1`.
- **Retrieval-промахи честные**: на «Q2 revenue» ретривал принёс Q1-отчёт и forecast, модель
  честно отказалась, judge поставил `refused`.
- **Не сделано**: `models.<tier>` override в `evals/config.json` не подключён (нужна поддержка в
  runtime); тиры S и L не прогонялись; judge по abstain/multiturn выключен (`judgeCategories`).
