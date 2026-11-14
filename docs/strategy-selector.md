# Strategy Selector v1

Этап 5, 2026-11-14. Ветка `codex/strategy-selector` построена поверх
`codex/task-analyzer@9243b1d` (PR #10 пока открыт). Новый экспорт
`dsh-metaaco/selector`; существующие Bank, Harness и MetaACO не меняются.

## Алгоритм и контекст

Использован disjoint LinUCB: отдельная ridge-модель на каждый arm. Основа —
[Li, Chu, Langford, Schapire, раздел 3.1 и Algorithm 1](https://arxiv.org/html/1003.0146#S3.SS1).
Сохраняем A = lambda*I + sum(x*xᵀ), b = sum(reward*x),
score = xᵀ*A⁻¹*b + alpha*sqrt(xᵀ*A⁻¹*x). Система решается через Cholesky,
без явного обращения матрицы. Alpha задаёт исследование, lambda — регуляризацию.
Оценка mean и exploration bonus сохраняются отдельно, это не измерения качества
и не калиброванные вероятности успеха. Гарантии regret для задач LLM не заявлены.

Контекст `selector-context-v1`: 18 признаков, доступных до исполнения:
intercept; one-hot bugfix/feature/refactor/testing/documentation/unknown;
multi-hot python/javascript/typescript/java/rust/go/react/node/sqlite/postgres;
unknown-stack. Признаки берутся из Task Analyzer rules-v1 без hints, одинаково
для истории и нового запроса. Неизвестный тип имеет собственный признак.
Сложность и произвольные требования ещё не входят в вектор.

Arm идентифицируется SHA-256 стратегии `{strategyId, version}` и route.
Смена версии стратегии, модели, инструментов, concurrency или TDD меняет arm;
прогнозы для очередной задачи не меняют его. Модели/инструменты — множества
строк с детерминированным порядком, модель должна быть задана вызывающим кодом
с provider/revision (например, условное `provider/model@revision`). Selector
не проверяет существование модели у провайдера и не назначает её агенту.

Cold start: A=lambda*I, b=0. При равных score выбирается первый arm в порядке
канонического JSON, независимо от порядка входа. Seed и propensity равны null:
случайного выбора здесь нет. История повторно проигрывается по attemptId;
одна попытка даёт максимум одно наблюдение. Нет изменяемого глобального learner.

## Контракты

`selectStrategy({ request, candidates, policy, snapshot, selectedAt = nowUTC })`
принимает TaskRequest v1, закреплённый снимок и следующие строгие объекты.

Candidate v1:

```js
{
  schemaVersion: 1,
  strategy: { strategyId: 'tdd-workflow', version: 1 },
  route: { models: ['offline/model@1'], tools: ['tests'], maxConcurrency: 1, tdd: true },
  taskTypes: ['bugfix'], // [] = нет ограничения по типу
  estimates: { wallTimeMs: 1000, costMicrounits: 100, quality: 0.8,
    currency: 'USD', source: 'pinned-forecast-v1' }
}
```

Числа иллюстративны, не тарифы. Прогноз может быть null. Значения quality —
в [0,1], деньги — неотрицательные safe integers в microunits, время — ms.
Внешний оркестратор получает стратегии через bank.listStrategies(), закрепляет
маршруты, даёт прогнозы с источником и проверяет совместимость со стеком,
репозиторием и acceptance criteria. Selector сам не генерирует прогнозы.

Policy v1:

```js
{
  schemaVersion: 1, revision: 'experiment-policy-v1', alpha: 0.2, lambda: 1,
  weights: { quality: 0.6, time: 0.2, cost: 0.2 },
  normalization: { wallTimeMs: 60000, costMicrounits: 1000000 },
  currency: 'USD', allowedModels: ['offline/model@1'], allowedTools: ['tests'],
  maxConcurrency: 2, maxWallTimeMs: 60000, maxCostMicrounits: 1000000,
  minQuality: 0.7
}
```

Сумма весов должна равняться 1; все веса неотрицательны. Нормировки положительны,
фиксируются до эксперимента. Допустимы alpha в [0,100], lambda в [1e-6,1e6].
Ограничения времени, денег и качества могут быть null (не задано).
До расчёта score отбрасываются запрещённые модели/инструменты, превышение
concurrency, tdd=false, несовместимый task type, нарушение заданных ограничений
по прогнозам. Неизвестный прогноз при заданном ограничении исключает кандидата;
для денежного ограничения требуется совпадение валюты. Исследование не обходит
фильтры. Если допустимых кандидатов нет, selected=null и причины сохранены.

**Граница гарантий:** прогноз не является верхней границей расходов или времени.
Selector не резервирует деньги, не разрешает LLM-вызов и не гарантирует прохождение
тестов. Реальные денежные лимиты требуют BudgetController в точке dispatch;
качество подтверждает независимый evaluator после исполнения. Declared TDD и
прогноз quality — условия допуска, не доказательства корректности.

Результат SelectionDecision v1 содержит decisionId (SHA-256), requestHash,
selectedAt, algorithm, featureSchema, context, полную policy и policyHash,
список candidates с прогнозами, scores, excluded с причинами, training с
reward/reason по каждой попытке, selected `{armId, strategy, route}`, snapshotId,
seed=null и propensity=null с объяснением. Сохраняйте его как
`beginAttempt({ ..., selection: { selector: decision } })`.
Перед исполнением необходимо связать выбранный route с реальным исполнителем;
в этой версии это обязанность доверенного оркестратора, не автоматизация Harness.

## История, награда и независимая оценка

`createSelectorSnapshot(bank, { trainingTaskIds, cutoff })` требует явного
train-списка и canonical UTC cutoff. Сохраняет только терминальные попытки,
завершённые строго до cutoff. Снимок включает все их исходы/метрики, контекст,
привязку к выбранному arm, результат проверки происхождения evaluator.
Никакие плохие попытки не удаляются из банка. Снимок и decision хешируются.
При выборе cutoff не может быть позже selectedAt; текущий taskId исключается.

Для привязки истории нужны selector decision с корректным хешем, requestHash,
совпадающими strategy/context/arm. Старые попытки без decision остаются в
снимке с причиной unbound-selection и не получают вымышленного маршрута.
Смена arm не наследует результаты прежней версии. Успех принимается только
из EvaluationResult v2 с passed correctness/TDD и обязательными тестами,
источником independent-node-evaluator и совпадающими evaluatorId/specHash
с сохранённой evaluation-session и TaskRequest.testSpec.

Это проверка связности локальной доверенной записи, не криптографическая
аттестация: сторона с произвольной записью в Bank может подделать происхождение.
Evaluator повторно не запускается при выборе. Legacy успех или неполное
подтверждение качества остаются без награды с причиной.

Награда фиксирована в `disjoint-linucb-v1`:

- failed/timeout/cancelled/interrupted: -1 (консервативная политика неуспеха,
  включая отмену по внешним причинам; частичные расходы остаются в снимке);
- inconclusive: null, не обучает модель; причина сохраняется;
- подтверждённый success: wq + wt*(1-min(time/timeScale,1))
  + wc*(1-min(cost/costScale,1)), в [0,1].

Таким образом, дешёвый провал не даёт положительную награду. Для success
используются measured.wallTimeMs и calculated.costs из MetricsCollector v1,
не estimates и не provider billing. Цена — расчёт по токенам, не счёт провайдера.
Стоимость требует complete coverage/pricing и одной валюты policy; полный
нулевой набор вызовов имеет реальный ноль. Неполный usage, смешанные валюты,
неизвестное время дают null reward, когда соответствующий вес положителен.
При нулевом весе ненужная метрика не препятствует обучению. Неполные исходы
не импутируются; это может сместить обучение, доли пропусков нужно отчётно учитывать.

## Сохранение и воспроизводимость

```js
import { createSelectorSnapshot, selectStrategy } from 'dsh-metaaco/selector'

const snapshot = createSelectorSnapshot(bank, { trainingTaskIds, cutoff })
const decision = selectStrategy({ request, candidates, policy, snapshot, selectedAt })
if (decision.selected !== null) {
  const ref = bank.putArtifact(Buffer.from(JSON.stringify(snapshot)))
  bank.beginAttempt({ attemptId, request, strategy: decision.selected.strategy,
    selection: { selector: decision, trainingSnapshot: ref } })
  bank.attachArtifact(attemptId, 'selector-training', ref)
}
```

На отложенном тесте повторно используйте один сохранённый snapshot. Новые
результаты не обновляют его. Вызывающая сторона отвечает за корректность
train/validation/test разбиения, дубликаты семейств, время cutoff и реальное
исполнение выбранного route. Хеш обнаруживает изменение, не удостоверяет
автора или правильность train manifest. Снимок содержит evaluation evidence,
логи и outcome, поэтому хранится приватно, вне Git.

Изменение весов пересчитывает rewards по закреплённым исходам; decision хранит
новую policy revision/hash. Автоматический online feedback отсутствует.
Все семь baseline и полноценный experiment runner остаются следующей работой;
unit-тесты с синтетическими исходами не доказывают экономию или научное преимущество.

## Проверки

RED: восемь начальных тестов падали из-за отсутствия selector API в успешно
загруженном модуле. GREEN: аналитический ridge/bonus пример, contextual выбор,
веса стоимости/времени, ограничения, неопределённость, версии arms, train cutoff,
целостность snapshot. Дополнительно проверены legacy успех и полный offline
путь Bank → selector → настоящий TDD Evaluator/Collector → snapshot → selector,
включая реальные RED/GREEN/REFACTOR subprocess и воспроизведение из artifact.
