# Task Analyzer v1

Этап 4, 2026-11-14. База: `main@c13e7a1` (Bank, Node Evaluator,
Metrics Collector объединены). Эта feature-ветка добавляет offline API
`dsh-metaaco/analyzer`, без автоматического подключения к Harness.

## Контракты

`analyzeTask(request, { hints = {}, analyzedAt = nowUTC } = {})` принимает
существующий TaskRequest v1. Дополнительные поля запроса, в том числе outcome,
отклоняются. `hints` допускает только:

- `type`: `bugfix | feature | refactor | testing | documentation`;
- `complexity`: `low | medium | high`;
- `stack`: массив непустых названий технологий;
- `requirements`: массив непустых декларативных требований.

Списки нормализуются в lowercase, дедуплицируются и сортируются. Требования
сохраняются как метки, не исполняются и не заменяют закреплённый `testSpec`.
Дата должна быть канонической UTC ISO-строкой с миллисекундами.

Результат: `schemaVersion: 1`, `analyzerVersion: rules-v1`, taskId, analyzedAt,
SHA-256 `requestHash` и `inputHash` (последний включает нормализованные hints),
classification.type/complexity, stack, requirements, estimates и provenance.
Каждая характеристика имеет `value`, `source`, `confidence`, `reason`.
Для деклараций confidence=null: это заявление вызывающей стороны, а не
вероятность. Для правил confidence=`heuristic`, без численной калибровки.
При неизвестном значении value=null с причиной. В estimates время, стоимость
и качество пока неизвестны; измерений в этом контракте нет.

Русские/английские ключевые слова дают тип задачи и стек. Несколько типов
дают неопределённость, без скрытого приоритета. Например, «Add tests» может
совпасть с feature и testing; явный hint разрешает неоднозначность. Отрицания,
цитаты и сложные формулировки не интерпретируются семантически. Сложность
требует явной оценки объёма: длина промпта не считается сложностью.
Результат анализа не содержит сырого description. Хеши не анонимизируют исходные данные.

## Поиск по истории

`createHistorySnapshot(bank, { trainingTaskIds, cutoff })` требует явного списка
разрешённых train taskId и временной границы. Через одну транзакцию чтения Bank
получает завершённые попытки строго до cutoff. Включает failed, cancelled,
timeout, interrupted, inconclusive и succeeded; исключает running.
Снимок содержит запросы и ссылки на попытки/стратегии с состояниями и датами,
без оценок качества, токенов, расходов или ответов агентов. Запрос задачи один,
сколько бы попыток ни было. `snapshotId` — SHA-256 канонического содержимого.

`findSimilarTasks(request, snapshot, { limit = 10 } = {})` проверяет версию и
целостность снимка, заново извлекает признаки только из описаний запросов и
ранжирует задачи по Jaccard множества `type:*` и `stack:*`. Равные оценки
упорядочены по taskId (сравнение кодовых единиц, без зависимости от locale).
Текущий taskId, задачи без пересечения и неизвестные признаки не добавляют
совпадений. Результат содержит snapshotId, requestHash, limit, algorithm,
taskId/score/sharedFeatures/attemptIds для каждого совпадения.
Hинты и сложность пока не участвуют в поиске: исторические запросы v1 не
имеют одинаково закреплённых деклараций. Оценка сходства не равна качеству
стратегии; успешность, цена и количество повторов не повышают score.

Снимок отделён от банка: новые попытки не меняют предыдущие результаты поиска.
Проверка хеша обнаруживает изменение содержимого, но не удостоверяет автора.
Experiment runner обязан обеспечить правильное train-разбиение, отсутствие
дубликатов по семействам/репозиториям и выбор cutoff до начала оценки. Analyzer
не может распознать held-out задачу, ошибочно включённую вызывающей стороной
в trainingTaskIds. Для frozen evaluation сохраняйте сам снимок, не только ID.
Снимки содержат исходные TaskRequest: храните их как приватные данные банка,
не коммитьте пользовательские промпты.

## Интеграция с Bank

```js
import { analyzeTask, createHistorySnapshot, findSimilarTasks } from 'dsh-metaaco/analyzer'

// trainingTaskIds and cutoff come from the pinned experiment manifest.
const snapshot = createHistorySnapshot(bank, { trainingTaskIds, cutoff })
const analysis = analyzeTask(request, { hints, analyzedAt })
const retrieval = findSimilarTasks(request, snapshot)
const snapshotArtifact = bank.putArtifact(Buffer.from(JSON.stringify(snapshot)))
bank.beginAttempt({ attemptId, request, strategy,
  selection: { analysis, retrieval, snapshotArtifact } })
bank.attachArtifact(attemptId, 'training-history', snapshotArtifact)
```

Здесь strategy выбирает вызывающий код. Analyzer не выбирает модель и не
запускает workflow. Существующая immutable selection сохраняет анализ и
поиск без миграции SQLite. Метрики overhead можно собирать существующим
Collector на стороне оркестратора; автоматического измерения здесь нет.
Поиск линейный, снимок в памяти; индекс и contextual selector — следующие этапы.

## Проверки

RED: до реализации семь тестов падали из-за отсутствующего API при успешно
загруженном модуле. GREEN: тесты анализа, неоднозначности, валидации,
train/cutoff, неизменного снимка, поиска и сохранения через Bank прошли.
Дополнительный тест проверяет ранжирование без влияния повторов/исходов
и строгое исключение попытки на границе cutoff. Все тесты offline.
