# Единый цикл попытки и бюджет адаптера

Проверяемая реализация 2026-11-14: ветка `codex/adaptive-attempt` поверх
`codex/dag-metrics-feedback@ff7a574`. PR #12–14 на начало этапа открыты.
Это программный API для доверенного приложения, не готовый CLI или платный запуск.

## Контракт orchestration v1

`dsh-metaaco/orchestration` экспортирует асинхронный `runAdaptiveAttempt`:

```js
const result = await runAdaptiveAttempt({
  bank, attemptId, request, feedback, candidates, bindings, baseSnapshot,
  createRuntime, planning: null, allowLlm: true, signal,
})
```

`request`, `feedback` и `candidates` используют существующие контракты Bank,
Feedback и Selector. Модели маршрута этого API задаются точными строками
`provider/model`. `baseSnapshot = {revision, files}` должен соответствовать
request.baseCommit, TestSpec закрепляется до исполнения. Тесты нельзя подменить
файлами snapshot. Исполняемый код проверяется существующим Node evaluator:
это процессная изоляция доверенных локальных fixtures, не OS sandbox для
произвольного вредоносного кода.

Каждый binding имеет `{schemaVersion: 1, armId, plan, greenTaskId, refactorTaskId}`.
Для выбранного arm нужен ровно один binding. Все модели плана явные и принадлежат
выбранному маршруту; agentSlots не превышает его maxConcurrency. REFACTOR обязан
непосредственно зависеть от GREEN и получать его artifact через input binding.
План/промпты готовит доверенное приложение: оно включает контекст задачи и
исходники в промпты; API не генерирует содержимое стратегии и не применяет патч
к рабочему репозиторию. Оба контрольных узла возвращают строгий JSON snapshot
`{revision, files}`, без Markdown fences. Промежуточные узлы возвращают текст.

Поток:

1. Проверить consent, policy, binding, snapshot, необязательное MetaACO planning;
   выбрать arm по закреплённому Feedback. При отсутствии допустимой стратегии
   или неверном входе попытка не создаётся.
2. Создать новую попытку с selection, feedback ref и binding hash; сохранить
   binding, base snapshot, анализ задачи и независимую evaluator session.
3. Выполнить baseline regression и ожидаемый RED. При нарушении gates модель
   не вызывается; ошибка окружения даёт inconclusive, не корректный RED.
4. Создать runtime, выполнить DAG. Новый необязательный `verifyArtifact`
   в runDag вызывается после сохранения output, но до completed и запуска
   потомков. На GREEN/REFACTOR orchestration запускает независимые тесты.
   Провал GREEN блокирует REFACTOR. Отмену callback обязан учитывать по signal.
5. Освободить runtime, завершить метрики, сохранить outcome и независимое
   заключение. Успех допускается только по evaluator. Ошибка dispatch — failed;
   неполные доказательства/ошибка cleanup — inconclusive; timeout/cancelled
   отдельны. При отмене metrics сохраняются artifact и events; существующий
   cancelAttempt оставляет outcome=null. Ошибка Bank может препятствовать
   финализации: после crash нужен явный interrupted recovery.
6. Только для train задачи в online-train явно создать следующую версию
   Feedback. Для held-out/frozen вернуть прежнюю. Возвращается
   `{schemaVersion: 1, attempt, execution, feedback, feedbackError}`. Ошибка
   обновления Feedback не удаляет завершённую попытку; caller сохраняет ref
   и обрабатывает feedbackError. Повторный attemptId не запускается.

`planning: {result, problem}` опционален: используется существующая независимая
проверка настоящего MetaACO и runMetaacoDag. Исходный problem.plan должен совпадать
с binding.plan; solver меняет приоритеты, но не код задач. Solver вызывается
доверенным приложением заранее, его provenance и оценки сохраняются отдельным
artifact. Автоматического нового ACO нет.

## Доверенная фабрика runtime

`createRuntime({attemptId, signal, plan, guardAdapter})` возвращает
`{ctx, parent, subagentProvider, dispose}`. Это код конфигурации приложения,
не callback, который может написать исполняемый агент. Для каждой попытки нужен
собственный runtime. Фабрика обязана установить **только** адаптеры, возвращённые
`guardAdapter(rawAdapter, quote)`, и направить через них все модельные вызовы,
включая auxiliary calls. Нельзя оставить доступный необёрнутый adapter или
subagent provider, который сам отправляет запросы в обход ctx.llm.
При ошибке создания фабрика сама освобождает частично созданный контекст;
после успешного возврата dispose вызывается оркестратором.

Пример регистрации в опубликованном Harness:

```js
ctx.llm.registerAdapter(['configured-provider'], guardAdapter(rawAdapter, quote))
// dispose runtime: await ctx.fiber.dispose()
```

Конкретные credentials, provider adapter и тарифы сюда не включены. Тестовый
runtime использует LlmRuntime и Harness 0.2.1-rc.2 с offline adapter; реальная
совместимость сетевого провайдера пока не подтверждена.

## Бюджетная граница

`dsh-metaaco/metrics/budget-adapter` экспортирует `createBudgetedAdapter(adapter,
{collector, budget, attemptId, quote, models, tools, allowLlm, signal})`.
Он сохраняет metadata-методы исходного adapter и оборачивает оба пути:
stream и prepareCall → stream. Prepared handle одноразовый. Метаданные
prepareCall/resolveModel должны быть небиллингуемыми.

Синхронный доверенный quote получает копию фактически отправляемого запроса и
возвращает `{pricing, upperBoundMicrounits}`. Pricing — закреплённый тариф v1;
валюта обязана совпадать с BudgetController. Upper bound — **гарантированный
предел**, учитывающий реальные input bounds, enforced output/reasoning cap,
cache и дополнительные начисления. Прогноз из Selector таким пределом не является.
Если такого предела нет, quote должен отказать до I/O. Автоматического подсчёта
точного tokenizer input и выставления провайдерского output cap здесь нет.

Перед dispatch проверяются consent, отмена, точный model route и имена tool
schemas, затем резервируется сумма в общем SQLite ledger. Параллельные вызовы
не могут расходовать один и тот же остаток. Завершённый stream с нормальным finish
и достаточным usage сверяется с тарифом; остаток резерва освобождается. При
исключении, error/aborted finish, раннем закрытии iterator или неизвестном usage
резерв удерживается. Частичный usage всё равно сохраняется. Нарушение заявленного
upper bound блокирует дальнейшие вызовы; оно не может отменить уже выставленное
провайдером начисление. Автоматических retries нет; каждый новый stream резервируется
отдельно. Скрытые повторы внутри raw adapter не покрываются автоматически: их
необходимо отключить либо учитывать все их возможные расходы в гарантии quote.

При finite policy.maxCostMicrounits создаётся бюджет `attempt/<attemptId>`.
Без денежного лимита adapter всё равно проверяет маршруты/consent и пишет metrics.
Проверка tool schemas не является изоляцией filesystem/network/tool execution;
политику реального доступа к инструментам настраивает доверенное приложение.

## Метрики и ограничения

Чтобы не удвоить расходы, orchestration пишет calls только из guarded adapter,
не подключая одновременно Harness usage observer. Coverage остаётся false:
данный API не аттестует конфигурацию вызывающего приложения. Полный cost неизвестен,
известные токены и расчётные расходы сохранены; положительная cost-weighted награда
без полного доказанного покрытия не выдаётся. Тарифный расчёт не является billing.

Wall time collector охватывает работу после создания попытки, baseline/RED,
runtime setup, DAG, тесты и cleanup; предварительный selector/planner и последующий
Feedback сюда не входят. Поэтому это не полный latency пользовательского запроса.
Deadline policy действует с начала collector, требует кооперативного signal
в factory/provider/callback и ограничен диапазоном Node timer. Длительное
некооперативное dispose невозможно принудительно завершить этим API.

Offline тесты проверяют реальные GREEN/REFACTOR gates, неверный RED, отмену,
deadline, replay, cleanup, concurrent reservations, раннее закрытие stream,
терминальные ошибки, маршруты и consent. Интеграция соединяет настоящий внешний
MetaACO, опубликованные Harness/LlmRuntime, SQLite и независимый Node evaluator.
Семь baseline, научные серии и готовый пользовательский launcher остаются отдельно.
