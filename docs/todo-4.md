# TODO 4

Открыто по итогам сверки с ТЗ 2026-09-21 (`docs/QVAC Challenge.pdf`, раздел Improvements).
Здесь только улучшение **I.2** — «Simultaneous completion runs»; остальная сверка живёт в
[requirements-checklist.md](requirements-checklist.md), предыдущие списки — в
[todo.md](todo.md), [todo-2.md](todo-2.md), [todo-3-exp.md](todo-3-exp.md).

Формулировка ТЗ: «serve multiple completions from a single loaded model concurrently via
continuous batching instead of firing separate serialized `completion()` calls. Consume the
merged event stream and ordered results and handle per-prompt cancellation.»
Подпункт I.2.1: «Report on batch-level throughput (e.g. average, aggregate) versus sequential
completions».

## Где сейчас

| # | Компонент | Статус |
| --- | --- | --- |
| 1 | Один загруженный экземпляр на N промптов | есть: chat-модель резидентна, `modelId` один |
| 2 | Continuous batching (`batchCompletion`) | **только в эвал-харнессе**, в продукте нет |
| 3 | Merged event stream | **нет** |
| 4 | Ordered results | есть в judge (перекладка по индексу), в продукте нет предмета |
| 5 | Per-prompt cancellation | **нет**: `POST /v1/cancel/:id` убивает весь запрос |
| 6 | I.2.1 — отчёт по throughput | есть: embed массивом ×6 быстрее; judge-батч по 4 медленнее (14 с против 11 с на вердикт) → дефолт 1 |

## Открыто

- [ ] **Батч должен жить в `src/`, а не в обёртке эвалов.** Сейчас `sdk.batchCompletion` вызывается
      единственный раз — в `evals/lib/judge/judge.mjs:138`, то есть в инструменте оценки, а не в
      продукте. ТЗ просит обслуживать **одновременные запросы к продукту** из одного батча. Нужно:
      окно агрегации в рантайме (`src/runtime/index.js`): пришедшие за N мс запросы на chat-модель
      собираются в один `batchCompletion({ modelId, prompts })`; одиночный запрос идёт прежним
      путём `completion()`, без задержки. `src/chat/answer.js` при этом не должен знать, попал он
      в батч или нет — граница проходит по рантайму.
      Ограничение железа: модель надо грузить с `modelConfig.parallel = N`, llama.cpp делит `ctx_size`
      между слотами (тир M: 16384 / 4 = 4096 на промпт). С нашим контекстом 5–8k это значит
      `parallel` 2, а не 4, либо подъём `ctx_size` и рост RAM. Решить, что делаем на 8 ГБ.
      Замер I.2.1 уже показал, что на dev Mac батч по completions **медленнее** последовательного —
      пункт всё равно нужно реализовать, но в отчёте честно написать, при каком `parallel` и
      какой длине промпта он начинает выигрывать (кандидат: короткие промпты, batch 2–4, GPU-бэкенд).

- [ ] **Merged event stream.** `batchCompletion` возвращает `BatchCompletionRun`
      (`node_modules/@qvac/sdk/dist/schemas/batch-completion-stream.d.ts:441`):
      `events` — один общий `AsyncIterable<BatchCompletionEvent>`, где каждое событие помечено `id`
      промпта; `byId(id)` даёт отфильтрованный поток и `final`; `results` — массив в порядке
      промптов; `stats` — агрегатная статистика батча (`avgConcurrentSeq`), **per-prompt `stats`
      addon не отдаёт**. Нужно: демультиплексор над `events`, который раскладывает чанки по
      requestId наших HTTP-соединений и льёт их в соответствующие SSE-ответы. Осторожно с
      `results`: промис all-or-nothing, при `ContextOverflowError` падает весь батч — значит
      per-prompt финалы надо собирать через `byId(id).final`, а не ждать `results`.
      Побочный эффект для статистики: `src/chat/stats.js` целиком построен на per-round `stats`
      (`timeToFirstToken`, `promptTokens`, `cacheTokens`, `generatedTokens`, `tokensPerSecond`,
      строки 24-34), а в батче их нет ни одного. Значит: TTFT и TPS считаем сами по времени первого
      и последнего `contentDelta` на id, токены — по `usage` из финала, а батч-уровневые
      `run.stats` (`avgConcurrentSeq`) кладём отдельным полем рядом, не смешивая с per-request.

- [ ] **Per-prompt cancellation.** В SDK 0.18.2 её нет: `cancel()` принимает либо `{ requestId }`
      (весь батч целиком), либо `{ modelId, kind }` (всё, что крутится на модели) —
      `node_modules/@qvac/sdk/dist/client/api/cancel.d.ts`. При этом терминальный `stopReason:
      'cancelled'` в схеме объявлен **на промпт**, так что сам addon отмену одной последовательности
      различает. Нужно: проверить, есть ли до неё путь (эксперимент: прервать итерацию `byId(id)`,
      посмотреть, придёт ли `completionDone{stopReason:'cancelled'}` только для этого id), и если
      пути нет — реализовать на нашем уровне: перестать форвардить SSE и выкинуть промпт из батча,
      а `cancel({ requestId })` звать только когда отменены все промпты окна. В `src/runtime/cancel.js`
      появляется второй уровень ключа: наш `requestId` → (`batchRequestId`, `promptId`).
      Итог задокументировать в отчёте: что именно поддержано, а что уперлось в SDK.

## Заметки по API (проверено на 0.18.2, 2026-09-21)

- `batchCompletion({ modelId, prompts })` экспортируется из корня `@qvac/sdk`
  (`dist/index.d.ts:1`), сигнатура — `dist/client/api/batch-completion.d.ts`.
- `prompts[].id` опционален; если не задать, SDK выдаст свои и вернёт их в `run.ids`.
- Модель под батч грузится один раз с `parallel`; менять `parallel` на лету нельзя — это
  перезагрузка модели, то есть решение принимается при старте по тиру.
