# Metrics Collector и Budget Controller

Третий этап, рабочая ветка `codex/metrics-collector`, база `main@cc8df28`, 2026-10-25.
API: `dsh-metaaco/metrics`, дополнительная обёртка `dsh-metaaco/metrics/harness`.
Платные запросы, установка зависимостей и изменения серверной инфраструктуры не требуются.

## Что измеряется

MetricsCollector сохраняет события в Strategy Bank и строит воспроизводимый snapshot из одной read transaction. Новый процесс может перечитать историю; модель или workflow при этом не запускаются. Прогнозы задаются один раз отдельно от наблюдений. В API и документе ниже деньги всегда означают целые **microunits в указанной валюте**: 1 единица валюты = 1 000 000 microunits.

```js
import { MetricsCollector } from 'dsh-metaaco/metrics'

const metrics = new MetricsCollector({ bank, attemptId, estimates: { wallTimeMs: 1000 } })
metrics.startSpan('inspect', 'analysis')
// Выполнить анализ.
metrics.endSpan('inspect', 'completed')
// Запускать agents и evaluator; зарегистрировать model calls через recordCall.
metrics.finish('completed', { coverageComplete: false })
const outcome = metrics.snapshot()
// Решение о качестве принадлежит evaluator, не collector:
evaluator.finalize(outcome)
```

Collector нужно создать до анализа и планирования, а finish вызвать после тестов. wallTimeMs измеряет именно это окно; создание попытки до collector и запись окончательного результата после finish в него не входят. До finish это поле null с причиной. UTC timestamps нужны для журнала; длительности вычисляются монотонными часами. Суммы работы параллельных агентов отличаются от wall time. Отрицательные интервалы и сравнение разных clockId запрещены/помечаются unknown. После перезапуска нельзя восстанавливать монотонное время вычитанием UTC: несовместимые интервалы остаются null.

startSpan(spanId,category,source?) / endSpan(spanId,status,source?) поддерживают analysis, planning, queue, agent, test, workflow. Для каждой наблюдаемой категории snapshot содержит count, sumMs, unionMs, knownSumMs. Незавершённые интервалы не закрываются молча. Категории могут перекрываться: не суммируйте их как общий runtime. CPU time, память и время до доставки событий этим API не измеряются.

Отчёты TDDEvaluator автоматически читаются из evaluation-report artifacts. measured.testing содержит observedRuns, сумму durationMs реальных runner-запусков и их phase/status/hashes. Это сумма времени отдельных тестовых запусков, а не время CPU или union параллельных тестов. Повторы и неуспехи сохраняются.

## ModelCallRecord и цены

recordCall принимает один законченный **физический запрос**, включая failed/cancelled/timeout; каждый реальный retry получает новый callId. Повтор идентичного callId идемпотентен независимо от времени доставки, конфликт содержимого отклоняется. Новые события после finish запрещены атомарно в Bank. Ключи:

```js
metrics.recordCall({
  callId, provider, model, modelRevision, requestId, // неизвестные route/request значения — null
  status: 'completed', kind: 'agent', latencyMs: null,
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens },
  pricing: pricingSnapshot, // либо null
  billing: null,            // либо {currency,microunits,source}
  source: 'trusted-provider-adapter',
})
```

Допустимые status: completed, failed, cancelled, timeout, interrupted. kind — источник вызова, например agent, retry, compaction, evaluation. Collector не выводит usage из длины текста и не выдумывает API request ID или model revision. Отсутствующие счётчики становятся null, отрицательные/нецелые/небезопасные числа отклоняются. Противоречивый totalTokens также отклоняется, когда известны все его составляющие.

Формат нормализованных счётчиков соответствует установленному Harness 0.2.1-rc.2: inputTokens — только некешированный input; cacheReadTokens и cacheWriteTokens — отдельные непересекающиеся категории. outputTokens должен включать reasoningTokens. totalTokens и reasoningTokens не прибавляются к input/output/cache повторно. Адаптер другого провайдера обязан сначала привести счётчики к этой семантике; Collector не распознаёт её автоматически.

Pricing snapshot v1: `{schemaVersion:1,id,provider,model,modelRevision,currency,effectiveAt,source,rates}`. rates содержит inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens: целые microunits **за миллион токенов**. Route и modelRevision должны совпадать с записью вызова. Источник и effectiveAt фиксируются вместе с данными; актуальные рыночные цены не встроены в код.

calculateCost считает точное BigInt произведение, суммирует категории и округляет вверх до одного microunit **за весь вызов**. Переполнение безопасного JSON integer вызывает ошибку. Нулевой тариф позволяет определить нулевую цену категории без подстановки нулевого usage. Отсутствие нужного usage или тарифа даёт null с причиной, а не нулевую стоимость. Это рассчитанная цена по закреплённой модели тарификации, не счёт провайдера; отдельные минимальные сборы и тарифные ступени v1 не поддерживаются.

## Snapshot и неполнота

- measured: wallTimeMs, spans, observedCallCount, usage, knownUsage, coverageComplete, testing;
- calculated: costs по отдельным валютам, pricingComplete и unpricedCallCount;
- providerReportedBilling: отдельно полученные/переданные счета, по callId, с source;
- estimates: неизменяемый прогноз;
- calls: нормализованные записи с pricing snapshot и calculatedCost;
- accountingRevision, unavailable, provenance: версия поправок, причины неизвестных значений и границы наблюдения.

provenance.eventSequence закрепляет watermark журнала попытки; вместе с accountingRevision он определяет входную ревизию projection. Позже добавленные evaluator reports или billing corrections дают новый snapshot, не переписывая сохранённый ранее outcome.

coverageComplete по умолчанию false. Установить true можно только когда доверенный контроллер действительно наблюдал все вызовы, включая retries, evaluator, compaction и вложенных агентов. Известная сумма наблюдавшихся токенов — knownUsage; при неполном охвате usage остаётся null. По аналогии calculated.costs содержит knownMicrounits и nullable полный итог microunits. Валюты не конвертируются и не суммируются друг с другом. Пустой список costs не означает нулевую цену неизвестных запросов.

recordBilling(correctionId,callId,{currency,microunits,source}) добавляет поправку даже после terminal AttemptRecord. Дубликат не учитывается дважды; новый correctionId сохраняет новый исторический факт, последний определяет текущий billing для callId. Старый outcome, исходная модельная цена и качество не перезаписываются. В exportJsonl сохраняются все accountingCorrection, не только последняя. Provider billing здесь — сведения доверенного вызывающего адаптера, не самостоятельная проверка подлинности счёта. Позднее уточнение самого usage этим протоколом пока не поддерживается.

## Реальная интеграция с Harness

```js
import { runMeasuredWorkflow } from 'dsh-metaaco/metrics/harness'

const result = await runMeasuredWorkflow(ctx, parent, workflow, {
  collector: metrics, subagentProvider: 'offline', allowLlm: true,
  // В реальном приложении явное разрешение на LLM получает вызывающая сторона.
  // Необязательный sync resolver должен вернуть закреплённые route + pricing
  // именно текущего физического запроса; по умолчанию они неизвестны.
  routeForEvent: (session, event) => null,
})
```

Обёртка сохраняет существующий lifecycle runWorkflow: parent, cancellation, failed children и dispose. В отличие от низкоуровневого runWorkflow, этот API требует allowLlm:true до вызова engine. Он измеряет всё окно runWorkflow и получает workflow/agent-start/end. Агентные интервалы отмечены source=harness-observer-receipt: PTC доставляет события пакетами, поэтому эти интервалы не равны точной latency модели. Очередь до запуска child, request latency и provider model revision этими событиями не подтверждаются и не выдумываются.

Для собственных child session обрабатываются assistant/message и assistant/attempt. Берётся authoritative data.usage, иначе последний chunk usage из embedded stream; промежуточные usage не суммируются. Каждая settlement seq имеет отдельный callId. Ранние usage до workflow/agent-start буферизуются, затем связываются с childId; события других workflow не попадают в итог. Буфер ограничен 10 000 событиями. Полные промпты, сообщения и reasoning не сохраняются сборщиком, только счётчики и routing metadata. routeForEvent — доверенный callback; если metadata недоступна, верните null.

Observer ошибки возвращаются вызывающему; слушатели снимаются в finally. Старые и новые планы продолжают использовать прежний API. Новая обёртка пока принимает fixed workflow; validate/run планов v1/v2 не менялись.

Охват остаётся **частичным**: abandoned requests без durable settlement, отдельные compaction providers и вложенные агенты могут не попадать в эту ленту. Их можно инструментировать явными recordCall в точке provider dispatch; установленного проверенного глобального hook для всех этих случаев здесь нет. Обёртка не объявляет coverageComplete автоматически. Офлайн-интеграционный тест проверяет настоящий опубликованный engine/session events на синтетических usage, а не реальные токены модели или экономию API.

## Атомарный общий бюджет

```js
import { BudgetController } from 'dsh-metaaco/metrics'
const budget = new BudgetController({ bank, budgetId: 'experiment-1', currency: 'USD', limitMicrounits: 1000 })
const reservation = budget.reserve({ reservationId: 'physical-call-1', attemptId, upperBoundMicrounits: 100 })
// Если reservation.created === false, это не новое разрешение повторить вызов.
budget.settle({ reservationId: 'physical-call-1', settlementId: 'usage-v1', actualMicrounits: 40, source: 'calculated usage' })
```

Это иллюстративные числа, не тариф или разрешение на расходы. Все суммы в валюте данного budget. Определение budget неизменяемо. Один budgetId можно использовать для нескольких попыток/процессов. BEGIN IMMEDIATE атомарно проверяет остаток и резервирует деньги. spentMicrounits — последние известные суммы, heldMicrounits — удерживаемые неизвестные/ещё не сверенные вызовы, remainingMicrounits — доступный остаток. После restart резерв не исчезает; идентичный reserve идемпотентен и возвращает created:false.

Для безопасного по умолчанию dispatch доступен `budget.run({reservationId,attemptId,upperBoundMicrounits,allowLlm}, operation, costOf)`: до operation требуются allowLlm:true и новый резерв; повторное выполнение по тому же reservationId отклоняется. costOf синхронно возвращает известную стоимость в microunits данной валюты или null. После ошибки operation цена не считается нулевой: резерв удерживается до явного уточнения.

upperBoundMicrounits — **доказуемая верхняя граница всего operation**, включая вход, выход и возможные внутренние retries, а не прогноз средней стоимости. Без границы запрос отклоняется. Контроллер не проверяет истинность границы за провайдера: для жёсткой гарантии нужны provider token/output caps, полный учёт и запрет обходных вызовов. Не используйте run вокруг неограниченного workflow как будто это один ограниченный model call.

Если actual превышает reservation bound, факт сохраняется и budget блокирует последующие dispatch. run возвращает ошибку нарушения после записи суммы. Более поздняя корректировка на меньший счёт не стирает факт нарушения upper bound: требуется отдельное решение владельца политики, новый budget и учёт уже потраченных денег. Это не отменяет уже начисленные расходы.

Unknown settlement удерживает максимум исходного резерва и ранее известных сумм. Каждое уточнение получает новый settlementId и сохраняется append-only. Сверку разрешено выполнить после завершения попытки; качество попытки не меняется. Счёт recordBilling и budget settlement — разные записи: доверенный контроллер явно связывает их по reservation/call ID, автоматического двойного расходования нет.

**Граница реализации:** это готовый общий ledger/admission API для инструментированных dispatch. Он не перехватывает внутренние model calls существующей slash-команды Harness автоматически. runMeasuredWorkflow обеспечивает наблюдение, но не жёсткий денежный лимит внутри Harness. Полный enforcement требует интеграции в реальную provider точку запуска и будет использоваться будущим orchestration/DAG слоем. Разрешение на реальные API-вызовы в этой разработке не получено.

## Хранение и проверка

SQLite миграция 3 добавляет budgets, budget_reservations, budget_settlements, accounting_corrections. Старые стратегии, попытки, тестовые артефакты и форматы планов сохраняются. Перед миграцией пользовательского dataDir нужна резервная копия БД и artifacts. Здесь миграции проверены только на временных тестовых БД; пользовательские истории не обновлялись.

Запуск офлайн-примера теперь сохраняет и реальные метрики тестовых subprocess:

```sh
node examples/tdd-evaluation.js /absolute/path/to/history
pnpm test
METAACO_SOURCE=/path/to/real/metaACOwithCodex pnpm test:integration
METAACO_SOURCE=/path/to/real/metaACOwithCodex python3 -B -m unittest discover -s python -v
```

Ограничения исходной локальной SQLite/Node инфраструктуры остаются: общая локальная файловая система, синхронное хранилище и replay небольших историй. Схема и contracts: [metrics.schema.json](../src/contracts/metrics.schema.json), [ADR 0003](adr/0003-metrics.md).
