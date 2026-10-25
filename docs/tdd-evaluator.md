# Независимый TDD Evaluator: локальный Node adapter v1

`import { TDDEvaluator } from 'dsh-metaaco/evaluation'`.
Evaluator сам запускает Node tests и собирает evidence. Он не принимает готовые TestReport или сообщение агента «тесты прошли» как вход оценки. Harness, MetaACO и платные API не вызываются.

## Контракт

`new TDDEvaluator({spec, bank?, attemptId?})` закрепляет отдельную JSON-копию TestSpec. Если указан bank, attemptId обязателен: попытка должна быть running, её `request.testSpec` должен точно совпадать со spec, а baseline/red revision — с `request.baseCommit`. На попытку допускается одна evaluator session; автоматического resume evidence другой сессии нет.

TestSpec v1:

```js
{
  schemaVersion: 1,
  id: 'feature-tests-v1',
  acceptanceCriteria: ['Description of the required behavior'],
  timeoutMs: 3000,          // на один запуск suite
  maxOutputBytes: 100000,  // stdout + stderr на один suite
  suites: [
    { id: 'feature', kind: 'target',
      expectedRedTests: ['exact failing test name'],
      files: { 'test/feature.test.cjs': '/* trusted Node test source */' } },
    { id: 'existing', kind: 'regression', expectedRedTests: [],
      files: { 'test/regression.test.cjs': '/* trusted regression tests */' } },
  ],
}
```

Нужны минимум один target и один regression; дополнительные acceptance suite выполняются в GREEN/REFACTOR. Идентификаторы suite и пути тестов уникальны. Поддерживаются *.test.cjs, *.test.mjs, *.test.js; все файлы suite исполняются как тесты. Общие helper-файлы можно включить в snapshot. Node test names для target должны соответствовать expectedRedTests. Не называйте тест именем пути тестового файла: такие события консервативно считаются file-level, а не evidence выполнения проверки.

Snapshot: `{revision: 'source-revision', files: {'src/file.cjs': 'source text'}}`. Код передаётся как явно заданный текстовый manifest, не читается автоматически из рабочего checkout. Revision предоставляет доверенный orchestration; evaluator вычисляет хеш фактических файлов, но не удостоверяет соответствие строкового revision Git-коммиту. Получение manifest из Git — отдельный будущий адаптер.

Пути должны быть относительными, без `..`, `.git`, `node_modules`, обратных слешей и двоеточий. Snapshot не может подменять пути закреплённых тестов. Ограничение размера snapshot/spec — по 10 MiB, suite — до 64, output — до 10 MiB. Файлы бинарных артефактов и установка зависимостей этой версией не поддерживаются.

## Фазы и решение

```js
await evaluator.runPhase('baseline', baseSnapshot)
await evaluator.runPhase('red', baseSnapshot)
// После RED orchestration передаёт задачу агенту и получает implementationSnapshot.
await evaluator.runPhase('green', implementationSnapshot)
await evaluator.runPhase('refactor', refactorSnapshot)
const result = evaluator.evaluate()
// Записать terminal AttemptRecord и запретить дальнейшие фазы:
evaluator.finalize({ measured: { cost: null }, estimates: {} })
```

Baseline запускает regression suite. RED запускает target suite на том же snapshotHash. Для положительного RED все упавшие проверки должны иметь именно закреплённые имена и ERR_ASSERTION. Ошибка импорта, runner, timeout, пропуск или уже зелёный target не доказывают воспроизведение дефекта.

GREEN/REFACTOR запускают все suite, без пропусков. Неудачный GREEN можно повторить с исправленным snapshot до REFACTOR; последние GREEN/REFACTOR определяют состояние. Все прежние отчёты сохраняются. После начала GREEN нельзя дописать RED задним числом; после REFACTOR нельзя вернуться к GREEN. Одновременные фазы одной сессии отклоняются. Повторный baseline или RED запрещён; для новой проверки исходных предпосылок нужна новая попытка.

Если рефакторинг не меняет код, повторите финальные проверки на том же snapshot; отсутствующая REFACTOR evidence не подменяется предположением об успехе. Можно начать сразу с GREEN для проверки готового патча, но TDD при этом останется inconclusive.

EvaluationResult v2 разделяет:

- `correctness`: все обязательные проверки финального снимка passed / хотя бы одна assertion failed / оценка inconclusive;
- `tddCompliance`: наблюдались baseline → ожидаемый RED → GREEN → REFACTOR, либо evidence failed/inconclusive;
- `status`: success только при обеих passed и полном mandatory наборе. Провал обязательного теста блокирует success всегда.

Error, timeout, cancelled, output-limit, integrity-error, skipped и отсутствие реально зарегистрированных тестов не дают GREEN. Если сломан baseline, evaluator сохраняет его, не исключает красные тесты молча и не подтверждает TDD. В evidence сохраняются причины и все фазовые отчёты, включая неудачи.

Неожиданная ошибка подготовки/сохранения фазового запуска возвращается вызывающему и фиксируется как ошибочная фаза в локальной evidence: предыдущий успешный snapshot не подменяет её. При недоступном Bank запись ошибки в постоянную историю не гарантируется, но положительное решение блокируется.

## Что сохраняется

Каждый suite запускается в новой временной рабочей копии с фиксированной командой Node, без shell. Доверенный reporter различает реальные тестовые события и текст stdout. Отчёт содержит schemaVersion, suite/kind, команду, UTC start, monotonic durationMs, Node/OS/arch, хеши suite/snapshot, revision, exitCode, signal, stopReason, counts, события, stdout/stderr и ошибки целостности. Входные файлы сверяются после исполнения: их изменение или удаление запрещает положительный результат.

С Bank отдельный TestSpec и каждый TestReport сохраняются как content-addressed artifacts; по каждому завершённому suite и фазе записывается событие. Финальная оценка сохраняется в artifact `evaluation-result` и AttemptRecord. Все предыдущие проверки остаются доступными при неуспехе. Timeout тестового subprocess хранится в TestReport; это не обязательно timeout всей попытки, которую orchestration может отдельно завершить через `bank.timeoutAttempt`.

evaluate() возвращает снимок, изменение возвращённого объекта не меняет evidence. finalize() закрывает сессию и, если подключён Bank, вызывает его структурную проверку EvaluationResult v2. Автоматического расчёта model/API cost нет: этот этап собирает тестовую evidence, полный Metrics Collector следует отдельно.

## Границы доверия и среды

Это локальный runner для **доверенного кода и зависимостей**, а не sandbox для произвольных недоверенных программ. Отдельный процесс, очищенное окружение, лимит Node heap 128 MiB, timeout и output cap не запрещают доступ к файлам хоста, сети или системным вызовам. Проверка файлов после выполнения также не защищает от активного злоумышленника, способного изменять и восстанавливать их или вмешиваться в Node assertions. Скрытые тесты не получают отдельного OS access control. Spec и snapshot должен закреплять доверенный контроллер до передачи задачи исполнителю.

API-ключи и NODE_OPTIONS автоматически не наследуются; зависимости не устанавливаются. Для пакетов с внешними библиотеками, Python/JVM тестов, скрытых suite с ограничением доступа и недоверенного кода требуется отдельный runner adapter с подтверждённой изоляцией. Данная версия не обещает такую поддержку. macOS проверена; Linux process-group cleanup реализован, но отдельно не проверен. На native Windows убийство всего дерева дочерних процессов не гарантируется; для строгого resource isolation нужен другой adapter.

Evaluator подтверждает наблюдаемую последовательность собственных тестовых запусков. Он не доказывает, что автор не написал реализацию заранее вне контролируемого workflow. Поэтому orchestration должен запросить реализацию только после зарегистрированного RED. Контроль сценария и предоставление snapshot — ответственность доверенного приложения.

## Пример и проверки

Полный пример с настоящими локальными тестами и Bank:

```sh
node examples/tdd-evaluation.js /absolute/path/to/local-history
pnpm test
pnpm test:integration
```

Пример не использует LLM и не начисляет API-cost. В существующей истории каждый запуск создаёт новую попытку одной неизменяемой задачи.

JSON Schema: [evaluation.schema.json](../src/contracts/evaluation.schema.json); runtime проверки дополняют её проверкой путей, уникальности, размера и порядка фаз. Решение и TDD evidence описаны в [ADR 0002](adr/0002-tdd-evaluator.md).
