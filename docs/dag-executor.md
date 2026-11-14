# DAG Executor: план v3

Этап 6, 2026-11-14. Проверенная база `main@e1252eb`: PR #10 (Analyzer)
и #11 (Selector) объединены. Ветка `codex/dag-executor` добавляет отдельный
экспорт `dsh-metaaco/execution`. Планы v1/v2, старые команды preview и
runWorkflow/runPlannedWorkflow сохраняют прежние интерфейсы и поведение.

## Контракт

Полный пример: [examples/dag-plan.json](../examples/dag-plan.json).

```js
{
  version: 3, execution: 'dag', name: 'task-workflow', description: 'Task DAG',
  resources: { agentSlots: 2, maxArtifactBytes: 65536, maxInputBytes: 262144, timeoutMs: 60000 },
  tasks: [
    { id: 'source', prompt: 'Produce a textual patch.', dependsOn: [], inputs: [], slots: 1, model: null },
    { id: 'consumer', prompt: 'Inspect the patch.', dependsOn: ['source'],
      inputs: [{ name: 'patch', taskId: 'source' }], slots: 1, model: null }
  ]
}
```

Все поля обязательны, неизвестные поля отклоняются; только lossless JSON.
Имена/id — kebab-case, максимум 64 символа. От 1 до 256 задач, 1–256 слотов;
task.slots — положительный целый вес, не превышающий ёмкость. Dependencies
уникальны, ссылки существуют, циклы запрещены. Имя каждого input уникально
в задаче; producer обязан быть её прямой зависимостью. Dependency без input
означает только порядок, а не автоматическую передачу результата.

`model` — null (наследование Harness) либо `{provider, model}`. Эти строки
передаются через поддержанные Harness 0.2.1-rc.2 `agent()` options в
subagent request.agentOptions. Они не равны `subagentProvider` (адаптер запуска,
например `spawn` или тестовый `offline`). Поддержка реальной модели, её версия,
доступность и соответствие политике — обязанности вызывающего оркестратора.

`validateDag(plan)` возвращает независимый снимок. `previewDag(plan)` возвращает
граф, input bindings, модельные overrides и ресурсы без промптов и без запуска.
`validatePlan()` для старых Python-планов v1/v2 не принимает v3: явная граница
не позволяет молча превратить прежний последовательный план в DAG.

## Исполнение и артефакты

```js
import { previewDag, runDag, DagExecutionError } from 'dsh-metaaco/execution'

console.log(previewDag(plan))
// attemptId уже создан в Bank. Разрешение на реальные API нужно получить отдельно.
const report = await runDag(ctx, parent, plan, {
  bank, attemptId, allowLlm: true, subagentProvider: 'offline', signal,
})
```

До dispatch обязательны явный allowLlm:true, parent и running Bank attempt.
Preview не требует их. На один attempt разрешён один DAG: dag/start с уникальным
executionId записывается до запуска, конкурентная или повторная попытка
конфликтует. Автоматического retry/resume нет, после сбоя создаётся новая попытка
по решению оркестратора. Наличие allowLlm в примере не разрешает платные вызовы.

Host scheduler выбирает готовые задачи в порядке массива, если их slot demand
помещается в доступную ёмкость. Каждая задача — отдельный настоящий Harness run
с фиксированным plugin-owned script и максимум одним child. Нет барьера между
независимыми ветками: потомок начинает работу после своего producer, пока
другой корень ещё работает. На одном запуске соблюдается сумма task.slots;
глобальный лимит между несколькими DAG/process не реализован.

Результат каждого child — текстовый артефакт, записанный через Bank.putArtifact
и привязанный как `dag-output/<taskId>`. Отсутствующий/неуспешный результат не
создаёт доступный потомкам артефакт. Входы читаются через Bank.getArtifact с
проверкой SHA-256 и размера. Harness получает JSON envelope в prompt:

```js
{ schemaVersion: 1, task: 'Original task prompt',
  artifacts: [{ name: 'patch', producer: 'source', sha256: '...', content: '...' }] }
```

Содержимое никогда не интерполируется в исполняемый script и не выполняется
как shell/code. Это текстовые данные для модели; JSON сам по себе не является
защитой модели от prompt injection. Автоматического применения патча, копирования
файлов в workspace или двоичных артефактов в v3 нет. Потомок получает только
явно указанные inputs. Bank хранится приватно: планы, артефакты и причины ошибок
могут содержать пользовательский текст. Не коммитьте рабочий dataDir.

maxArtifactBytes ограничивает один выход (до 16 MiB), maxInputBytes — итоговый
UTF-8 envelope (до 16 MiB). Сумма размеров входных артефактов проверяется также
до чтения очередного producer. Выход проверяется после получения полного
результата Harness; это не ограничение токенов провайдера или памяти процесса.

## Ошибки, отмена и журнал

Состояния узла: pending → running → completed/failed/cancelled/timeout;
неисполненный потомок провала получает blocked. Независимые ветки продолжают
работать. Вызывающий AbortSignal и общий timeout прекращают новый dispatch,
отменяют активные Harness runs, дожидаются освобождения handles. dispose()
вызывается также при ошибке результата и на неуспешном child. Ошибка освобождения
ресурса делает узел failed. Deadline кооперативный, а не принудительное убийство
произвольного провайдера; завершение требует соблюдения Harness lifecycle.

Сбой журналирования останавливает оркестратор и отменяет активных соседей.
Если банк недоступен, завершённый журнал гарантировать невозможно; ошибка
возвращается вызывающему. После аварии процесса Bank attempt остаётся running
и явно переводится владельцем в interrupted через существующий recovery API.
Нельзя автоматически считать такую попытку успешной или повторно оплатить её.

Сохраняются plan artifact, dag/start, task running/terminal events и dag/finish.
Report содержит executionId, planHash, status, wallTimeMs и для каждого узла
state, artifact, использованные inputs с provenance/hash, Harness runId,
wallTimeMs и reason. Время — монотонное измерение orchestration + execution +
artifact I/O; оно не CPU time и не прогноз solver. Не запущенные узлы имеют
wallTimeMs=null. Недоступный runId/artifact также null.

При failed/cancelled/timeout выбрасывается DagExecutionError с `.report`.
При ошибке до начала DAG (validation/consent/pre-abort/Bank) — обычная ошибка.
`status: completed` означает только завершение графа, `quality: inconclusive`
сохраняется всегда. Executor не финализирует Bank attempt. Независимый TDD
Evaluator и MetricsCollector должны завершить попытку отдельным шагом.

## Ограничения и следующий этап

Логические slots не задают лимиты ОС CPU/RAM. Timeout и ограничения артефактов
не заменяют бюджет API. Usage/cost автоматически этим API не собираются:
нужны инструментированные provider calls и существующий BudgetController.
Без них расход неизвестен, а не равен нулю. Встроенный Metrics Harness observer
пока оборачивает старый fixed workflow; перенос наблюдения на DAG — отдельная
интеграция. События DAG дают тайминги/результаты, не полный API accounting.

StrategyDefinition v1 хранит прежний workflow; plan v3 сохраняется отдельным
artifact попытки. Связать выбранную стратегию, policy, route и v3 plan должен
оркестратор. Автоматический перевод MetaACO расписания в v3, end-to-end
selector pipeline и Feedback — следующие этапы. Реальный Python solver в этой
работе не изменён и не заменён.

## Проверки

RED: восемь исходных тестов падали из-за отсутствующего API, а не среды.
GREEN: проверки графа, раннего запуска потомка, ресурсов, артефактов, ошибок,
pre-abort, отмены, timeout, replay protection и plan snapshot. Дополнительно
проверены ошибки start/dispose/журнала и сохранение runId неуспешного child.

На настоящем установленном Harness offline-провайдером проверены передача
данных и model options, параллельность без барьеров, блокировка потомков при
ошибке, отмена и освобождение всех дочерних ресурсов. Платных LLM-вызовов нет.
