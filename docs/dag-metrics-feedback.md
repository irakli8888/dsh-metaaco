# Метрики DAG и версии Feedback

Состояние на 2026-11-14: ветка `codex/dag-metrics-feedback` поверх
`codex/metaaco-dag-integration@7b24512`. Это отдельные API, а не завершённый
автономный цикл приложения. PR #12 и #13 на момент начала работы открыты.

## Наблюдение исполнения

Экспорт `dsh-metaaco/metrics/dag` предоставляет `runMeasuredDag(ctx, parent,
plan, options)` и `runMeasuredMetaacoDag(ctx, parent, result, problem, options)`.
Они сохраняют контракт исходных исполнителей и дополнительно принимают
`collector` и синхронный `routeForEvent(session, event, {runId, taskId})`.
Collector должен относиться к тому же Bank и attempt; совпадение attemptId
проверяется до dispatch. Нужен явный `allowLlm: true`; это технический gate,
не разрешение владельца на платный эксперимент.

Каждый принадлежащий DAG run регистрируется отдельно. Ранние события
буферизуются до установления принадлежности child session, чужие usage не
записываются. Повторные settlement events дедуплицируются существующим ledger.
Agent spans включают run ID: одинаковые seq разных узлов не конфликтуют.
Буферы ограничены 10000 событиями. Переполнение или ошибка resolver/collector
прерывает DAG и возвращает AggregateError с доступным execution report;
подписки снимаются и незавершённые spans закрываются также при ошибках.

Resolver возвращает проверенные provider/model/modelRevision/pricing либо null.
Тариф нельзя угадывать из имени модели. Время spans измеряет получение событий
наблюдателем, не внутреннее время API. Известные токены и расчётная стоимость
сохраняются и при неудаче. Полные totals остаются null при неполном покрытии;
наблюдение Harness не доказывает охват всех физических retries/requests.
Обёртка не вызывает collector.finish(): вызывающий код завершает измерение
после независимой оценки. Автоматический hard-budget admission каждого запроса
Harness пока отсутствует. API-cost остаётся расчётом, не счётом провайдера.

## Неизменяемые версии истории

Экспорт `dsh-metaaco/feedback`:

- `advanceFeedback(bank, {manifest, policy, cutoff, previous = null})` возвращает
  artifact ref новой версии либо прежний ref при идентичном snapshot.
- `readFeedback(bank, ref)` возвращает `{revision, snapshot}` с проверкой хешей,
  структуры, cutoff, train IDs и сводки.
- `selectWithFeedback(bank, ref, {request, candidates, selectedAt})` выбирает
  стратегию по закреплённой истории и policy без чтения новых исходов.

Manifest v1 содержит `experimentId`, `mode: 'online-train' | 'frozen'` и
`splits: {train: taskId[], validation: taskId[], test: taskId[]}`. Списки не
пересекаются. Только завершённые train attempts с finishedAt строго раньше
cutoff входят в snapshot. Running, validation и test исключены. Корректность
разметки задач и разделение семейств похожих задач обеспечивает экспериментатор.

Revision v1 содержит revisionId (хеш), parent artifact ref, manifest, policy,
cutoff, snapshot artifact ref и summary состояний/новых attempt IDs. Всё хранится
через существующий content-addressed Bank; миграция БД не требуется. Смена policy
или splits требует новой линии версий. Cutoff монотонный; ранее наблюдённые
записи нельзя переписать/удалить, а поздно добавленные записи до уже закреплённого
cutoff требуют отдельной линии. Frozen запрещает обновление истории.

Положительное обучение использует существующую проверку independent evaluator
в Selector. Inconclusive и недоказанный успех не дают положительной награды;
failed/timeout/cancelled/interrupted сохраняются с консервативной наградой -1.
Отсутствующая метрика с ненулевым весом исключает reward успешной попытки.
Прогнозы кандидатов не становятся измерениями. LinUCB переоценивается по snapshot;
параметры policy автоматически не подбираются.

Вызывающий код хранит активный ref и закрепляет его вместе с selection в новой
попытке. Глобального mutable указателя нет: конкурентные обновления могут создать
две ветви, выбор активной версии остаётся обязанностью приложения. Hash проверяет
целостность, а не доверенность автора локального Bank.

## Порядок соединения

1. Закрепить manifest, policy и исходный feedback ref до запуска эксперимента.
2. Выбрать стратегию через selectWithFeedback и сохранить selection в Bank.
3. Создать collector для этой попытки, выполнить DAG с наблюдением.
4. Провести независимую оценку по закреплённым тестам; завершить метрики и
   попытку с фактическим исходом, включая неудачи и inconclusive.
5. Явно обновить online-train ref после train attempts. Для held-out evaluation
   использовать прежний frozen ref; сохранять исходы, но не обучаться на них.

Offline проверки покрывают несколько runs, ранние и повторные события, неудачу,
ошибки наблюдателя, consent/cancel, неверный attempt, воспроизводимый выбор,
изоляцию splits, frozen lineage и чтение после перезапуска Bank. Интеграция
использует опубликованный Harness с offline provider; реальные API не вызываются.
Сравнение семи baseline, многократные научные эксперименты и автоматический
end-to-end pipeline остаются следующими этапами.
