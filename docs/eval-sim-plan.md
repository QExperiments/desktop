# План: Claude как симулятор пользователя через MCP

Статус: **отложено**. Делается после ядра харнесса из [todo.md](todo.md) (трейсы, `requestId`, `run.mjs`).

## Оговорка

Claude Code это внешний AI-сервис. В этой схеме он видит свои вопросы и ответы агента,
а в ответах есть куски корпуса и цифры стока. Допустимо только на dev-машине с вымышленным
корпусом упражнения. С реальными данными Meridian не запускать. В продукт не входит.
Записать как допущение в `evals/README.md`.

## Идея

Claude сам ведёт диалог с локальным агентом в одной сессии: придумывает реплику, зовёт
инструмент `ask`, читает ответ, решает, что спросить дальше. Ожидание ответа это обычный
tool call: MCP-сервер внутри ждёт SSE до `[DONE]` и возвращает результат. Вердикт один,
в конце, по всему транскрипту и всем трейсам.

```
claude -p --mcp-config .mcp.json --max-turns 30 "<персона, цель, факты, рубрика>"
   │
   │ tool ask({ query })   ─▶ evals/sim/mcp-server.mjs ─▶ POST /v1/chat/completions
   │                                                       (stream, x-session-id, x-eval-run)
   │                       ◀─ { text, citations, requestId, ms }   ждёт до [DONE], пишет ход в results/
   │ … ещё N ходов; сервер отказывает после scenario.max_turns
   │ tool traces()         ◀─ все трейсы этой сессии из data/traces/<run>/
   ▼
финальный JSON { verdict, notes } ─▶ run.mjs дописывает в results/sim-<ts>/<scenario>.json
```

Почему MCP, а не оркестратор с `claude -p` на каждый шаг:

- одна сессия Claude на диалог, транскрипт не пересылается каждый шаг;
- «судим в конце по всему трейсу» ложится естественно: последний вызов `traces()`, потом вердикт;
- лимит ходов и запись результатов делает MCP-сервер, а не промпт;
- тот же `.mcp.json` даёт `ask` и интерактивной сессии Claude Code без обёрток через Bash.

## Файлы

```
evals/sim/
  mcp-server.mjs   stdio, @modelcontextprotocol/sdk, ~60 строк; инструменты ask, traces;
                   держит session id, счётчик ходов, пишет results/
  scenarios.jsonl  персона, цель, факты, max_turns
  rubric.md        как судить и в каком JSON отвечать
  run.mjs          цикл по сценариям: один `claude -p` на сценарий, парсинг вердикта
.mcp.json          { "mcpServers": { "meridian": { "command": "node", "args": ["evals/sim/mcp-server.mjs"], "env": { "PORT": "11435" } } } }
package.json       "eval:sim": "node evals/sim/run.mjs"
```

`ask.mjs` общий с основным харнессом (`evals/lib/ask.mjs`).

## Форматы

Сценарий:

```json
{ "id": "field-eng-apac-stock",
  "persona": "Field engineer on site, terse, asks follow-ups without repeating context.",
  "goal": "Find out if SD-X4-001 can ship to APAC this week and what the lead time is.",
  "facts": { "SD-X4-001 APAC available": 6, "lead time days": 7, "asOf": "2026-06-30" },
  "must_cover": ["availability", "lead time"],
  "max_turns": 6 }
```

`facts` берутся из корпуса и `stock-tool` заранее: судье нужна правда, а давать Claude
инструменты чтения корпуса дорого и лишний раз выносит данные.

Рубрика (контракт финального ответа):

```
Ты играешь персону. Задавай по одному вопросу за ход через ask. Хотя бы раз задай
эллиптический follow-up ("And in APAC?"). Одна попытка увести в тему вне корпуса.
Не подсказывай ответ. Когда цель достигнута или ходы кончились, вызови traces() и
ответь ТОЛЬКО JSON:
{ "verdict": { "goal_reached": bool, "correct_numbers": bool, "grounded": bool,
               "guessed_number": bool, "followups_resolved": bool, "tool_routing_ok": bool,
               "notes": "≤ 2 sentences" },
  "stop_reason": "goal_reached" | "dead_end" | "max_turns" }
```

Числа проверяет код по `facts`; Claude судит формулировку, grounded, follow-up и маршрутизацию тулов по трейсам.

## Запуск

```
node evals/sim/run.mjs --scenarios evals/sim/scenarios.jsonl --model sonnet --runs 3
  → для каждого сценария: claude -p --mcp-config .mcp.json --max-turns 30 --output-format json \
      --allowedTools mcp__meridian__ask,mcp__meridian__traces "<rubric + scenario>"
  → results/sim-<ts>/<scenario>.json = { scenario, transcript[], traces[], verdict }
  → score.mjs понимает этот формат так же, как turns.jsonl основного харнесса
```

Интерактивно: `.mcp.json` в корне репо, и в сессии Claude Code доступен `ask` напрямую.

## Что учесть

- Расход подписки: сценарий ≈ 6 ходов × 3–5k токенов. 20 сценариев ≈ 0.5M токенов, заметная
  доля пятичасового окна. Начинать с 5 сценариев, `--model sonnet` для симулятора.
- Недетерминизм с двух сторон. На сервере `seed` и `temperature: 0`, сценарии по 3 прогона,
  смотреть доли, а не единичный вердикт.
- Ответ на ноутбуке 2019 года может идти 30–60 с; при упоре в таймаут tool call поднять `MCP_TOOL_TIMEOUT`.
- Через `claude -p` работает точно. Claude Agent SDK делает то же программно, но подхватывает ли
  логин подписки без API-ключа, проверить на месте.
- Вердикт Claude это оценка, не факт: числа только кодом.
