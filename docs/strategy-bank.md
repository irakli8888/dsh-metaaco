# Strategy Bank v1

Локальная библиотека истории: `import { StrategyBank } from 'dsh-metaaco/bank'`.
Не запускает LLM, Python, workflow или тесты. Обоснование решений: [ADR 0001](adr/0001-strategy-bank.md).
Контракты: [JSON Schema](../src/contracts/bank.schema.json), runtime-проверки в `src/contracts/bank.js`.

```js
import { StrategyBank } from 'dsh-metaaco/bank'

const bank = new StrategyBank({ dataDir: '/absolute/path/to/local-history' })
try {
  const strategy = bank.register({
    schemaVersion: 1, strategyId: 'fixed-tdd', version: 1,
    provenance: { source: 'manual', revision: 'workflow-v1' },
    workflow: { name: 'fixed-tdd', description: 'Fixed coding task', stages: [
      { title: 'Implement', agents: [{ id: 'coder', prompt: 'Implement the requested change' }] },
    ] },
  })
  const attemptId = bank.beginAttempt({
    attemptId: 'task-42-attempt-1',
    request: {
      schemaVersion: 1, taskId: 'task-42', description: 'Add a function',
      repo: '/path/to/repo', baseCommit: 'actual-commit-id',
      testSpec: { command: ['node', '--test'], suiteRevision: 'suite-v1' },
      provenance: { source: 'user', revision: 'request-v1' },
    },
    strategy,
    selection: { policy: 'fixed-v1', seed: 42 },
  })
  bank.appendEvent(attemptId, 'workflow-started', {
    kind: 'workflow-started', payload: { provider: 'offline' },
  })
  const ref = bank.putArtifact(Buffer.from('An offline report\n'))
  bank.attachArtifact(attemptId, 'report', ref)
  // Пока независимый evaluator не выполнен, завершение workflow не подтверждает успех.
  bank.finalizeAttempt(attemptId, {
    status: 'inconclusive', requiredTests: [],
    provenance: { source: 'caller', reason: 'independent evaluation not available' },
  }, {
    measured: { wallTimeMs: null, cost: null }, estimates: {},
    unavailable: ['metrics not collected'],
  })
  const attempts = bank.listAttempts({ taskId: 'task-42' })
  const jsonl = bank.exportJsonl()
} finally {
  bank.close()
}
```

## API

Все методы синхронные; ошибки валидации/целостности/SQLite выбрасываются вызывающему.

| Метод | Результат и правила |
|---|---|
| register(definition) | `{strategyId,version}`; immutable version, повтор идентичного JSON допустим |
| getStrategy(id,version) / listStrategies() | отдельные JSON-снимки; отсутствующая стратегия — null |
| beginAttempt({attemptId,request,strategy,selection}) | attemptId; новая попытка running с неизменяемыми входами |
| getAttempt(id) | AttemptRecord или null; включает request, selection, timestamps, outcome/evaluation/reason |
| listAttempts(filters) | фильтры taskId, strategyId, state; сортировка по attemptId; ошибки не скрываются |
| appendEvent(attemptId,eventId,{kind,payload}) | envelope с schemaVersion, sequence, recordedAt; дедупликация на attemptId/eventId |
| getEvents(attemptId) | события по sequence; неизвестная попытка — ошибка |
| finalizeAttempt(id,evaluation,outcome) | terminal AttemptRecord; outcome требует отдельных объектов measured/estimates |
| cancelAttempt(id,reason) | массив с cancelled AttemptRecord |
| timeoutAttempt(id,reason,outcome) | terminal timeout с сохранением частичных measured/estimates и usage-событий |
| recoverInterrupted(ids,reason) | атомарно помечает только указанные running; убедитесь, что их владельцы остановлены |
| putArtifact(Uint8Array) / getArtifact(ref) | `{sha256,sizeBytes}` / Buffer с проверкой digest |
| attachArtifact(attemptId,name,ref) | immutable связь имени с содержимым, только зарегистрированный артефакт |
| exportJsonl() | snapshot metadata JSONL; bytes нужно сохранять отдельно |
| close() | освобождение SQLite, повтор безопасен |

EvaluationResult v1: `{status: 'success'|'failed'|'inconclusive', requiredTests: [{id,status}], provenance: {...}}`.
Статусы проверок: passed, failed, skipped, error; ID уникальны. Success требует непустого полностью passed набора.
Это структурная проверка отчёта, а не независимая оценка — реализация evaluator идёт следующим этапом.

Дополнительно принимается EvaluationResult v2: поля v1 плюс `schemaVersion: 2`, `correctness`, `tddCompliance`, `evidence`.
Независимые статусы correctness/tddCompliance — passed, failed или inconclusive. Success требует обоих passed.
Рабочий патч без RED можно сохранить с correctness=passed, tddCompliance=inconclusive, status=inconclusive.
База мигрирует до версии 2 для отдельного состояния timeout; перед обновлением пользовательской БД сохраните её копию вместе с artifacts.

Начальная StrategyDefinition хранит существующий fixed workflow; это не новый DAG-контракт.
Поиск похожих задач и ранжирование стратегий появятся с Task Analyzer/Selector. Сейчас доступны точные фильтры истории, включая неудачные попытки.
Вызовы моделей, model revisions, тестовые отчёты и usage можно сохранять в payload событий; автоматический сбор ещё не подключён.

База и артефакты создаются только в явно переданном dataDir. Выбирайте локальный каталог вне исходников и не публикуйте его с пакетом. Bank не сканирует окружение и не сохраняет API-ключи автоматически; содержимое payload и отчётов контролирует вызывающий код.
