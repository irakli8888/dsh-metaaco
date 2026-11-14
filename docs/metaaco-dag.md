# Интеграция настоящего MetaACO с DAG v3

Этап 7, 2026-11-14. Ветка `codex/metaaco-dag-integration` построена поверх
`codex/dag-executor@7d10f43` (открытый PR #12). Добавлены отдельный Python CLI
`python/metaaco_dag.py` и JS экспорт `dsh-metaaco/planning`. Старые CLI,
agent problem v1 и планы v1/v2 не меняются.

## Что оптимизируется

Используется доступный внешний `rcpsp.metaACO.ColonyManager`, без копии solver
и без fallback. Task.slots становится потребностью в одном возобновляемом
ресурсе, plan.resources.agentSlots — его ёмкостью. DependsOn сохраняются как
предшествования; длительности берутся только из явных прогнозов пользователя.
Оптимизируется Cmax в этой ресурсной модели. Стоимость и качество не становятся
целями RCPSP: их по-прежнему оценивают другие компоненты.

Подтверждённые параметры запуска: 3 начальные колонии, максимум 10, UCB,
replication_enabled=true, replication_mode=mutate, elite_enabled=true,
local_search_enabled=true, 20 итераций, 5 муравьёв и общий лимит 100 оценок,
improvement_threshold=0.02. Реальные мутации alpha/beta/rho/q0/ls_iters/ls_prob
и локальный поиск не изменены. Лимит оценок может закончить поиск раньше
всех итераций. Возвращённое расписание проверяет независимый core validator.

Источник изучен локально 2026-11-14; хеши core.py и metaACO.py совпадают со
снимком в [metaaco-algorithm.md](metaaco-algorithm.md). Исходники solver не
редактировались. Элитарный архив остаётся внутрипроцессным архивом расписаний,
не Strategy Bank. Автоматическое назначение лучших моделей этим мостом не делается:
оно сохраняется из входного плана без изменения.

## Вход и запуск без LLM

Problem v2: ровно `{version: 2, plan: <DAG v3>, durationEstimatesSeconds: {...}}`.
Словарь длительностей покрывает все taskId ровно один раз, значения — положительные
целые секунды. Контракт плана совпадает с [DAG Executor](dag-executor.md).
Ограничение суммы длительностей — 86400 секунд: настоящий SSGS выделяет массив
использования ресурсов по временной шкале. Проверка выполняется до выделения
этого массива. Это ограничение версии моста, не ограничение предметной области
MetaACO и не прогноз реального времени работы LLM.

```sh
python3 -B python/metaaco_dag.py \
  --source /Users/iraklijkvacahia/PycharmProjects/metaACOwithCodex \
  --problem examples/metaaco-dag-problem.json --seed 42
```

CLI выполняет только bounded solver, не вызывает модели. Stdout содержит JSON,
диагностика перенаправлена в stderr. Source обязателен; отсутствие реальных
core.py/metaACO.py, несовпадение уже загруженного модуля с указанным source,
невалидный граф или отсутствие расписания завершают работу ошибкой.
Ничего не скачивается и не устанавливается. Длительные серии не запускаются.

## Выход и воспроизводимость

Результат имеет schemaVersion=1, planner=`python-metaaco-dag`:

- plan: валидный DAG v3; изменён только порядок массива tasks;
- estimates: durationUnit=seconds, scheduleMakespan, исходный solver order,
  schedule с taskId/startSeconds/durationSeconds; executionMakespan=null с причиной;
- measured: solverWallTimeMs (монотонное время init/search) и фактическое число evaluations;
- provenance: seed, parameters, Python version, problemSha256, bridgeSha256,
  SHA-256 манифест загруженных `.py` модулей rcpsp с относительными путями.

Хеш входа — канонический JSON с сортировкой ключей; допустимые контрактные ключи
ASCII. JS и Python согласованность проверена в end-to-end тесте с русским текстом.
Manifest проверяется до/после поиска; изменение файлов/набора модулей отклоняется.
Для воспроизводимости запускайте свежий CLI-процесс с закреплённой копией source:
хеш файла не доказывает идентичность уже закешированного Python bytecode.
Время поиска может отличаться при одинаковом seed; план/расписание проверены
повторным запуском, но это не обещание повторяемости реальных LLM.

## Как расписание превращается в исполнение

Задачи сортируются по прогнозному startSeconds, при равенстве — по solver order.
Этот порядок становится приоритетом готовых задач для существующего DAG scheduler.
Все зависимости, artifact bindings, prompts, slots, модели и лимиты сохраняются.
Мост не добавляет искусственные зависимости между независимыми задачами и не
вставляет ожидания до прогнозных времён старта.

Поэтому scheduleMakespan — прогноз только расписания solver. Исполнитель может
выбрать доступную работу, пока более приоритетная ждёт зависимость, и реальная
длительность задач отличается от входного прогноза. Даже при точных длительностях
greedy dispatch и SSGS могут дать разные расписания. executionMakespan остаётся
неизвестным; фактическое время позже даст DAG report. Здесь нет заявления, что
solver Cmax равен runtime Harness или что этот переход улучшает эффективность.

## Независимая граница JavaScript

```js
import { validateMetaacoDag, runMetaacoDag } from 'dsh-metaaco/planning'

const validated = validateMetaacoDag(solverResult, originalProblem)
// Вызов ниже требует отдельного разрешения на реальные LLM.
const report = await runMetaacoDag(ctx, parent, validated, originalProblem, {
  bank, attemptId, allowLlm: true, subagentProvider: 'offline', signal,
})
```

validateMetaacoDag независимо проверяет точное покрытие задач, safe integers,
предшествования order/schedule, Cmax, event-sweep ёмкости weighted slots,
порядок проекции и неизменность каждого task/ресурсов относительно originalProblem.
Проверяются версии, фиксированные параметры, бюджет evaluations, формат source
hashes, хеш исходного problem и отсутствие вымышленного executionMakespan.
Функция возвращает независимый snapshot; Python и модели не запускаются.

Хеши — идентификаторы для воспроизведения, не подпись и не доказательство запуска
solver. Доверенный оркестратор обязан запускать закреплённый Python/source и
передавать результат из этого процесса. Поддельный, но допустимый граф можно
снабдить поддельными hashes; JS верифицирует допустимость, не подлинность источника.

runMetaacoDag требует consent и running Bank attempt, сохраняет весь planner
envelope как artifact `metaaco-dag-planning` и одноимённое событие, затем вызывает
существующий runDag. Consent/pre-abort/validation проверяются до записи и dispatch.
Планирование хранится отдельно от DAG report и от оценки качества. Повторный
запуск запрещён существующим dag/start; другое planning evidence не может
переписать immutable artifact binding. Банк содержит промпты — храните приватно.

## Проверки и оставшаяся работа

Python RED→GREEN: внешний solver, weighted demands, повторяемость, несовместимые
inputs/source и CLI JSON. Дополнительный RED→GREEN ограничивает time-indexed
horizon до выделения памяти. JS RED→GREEN: независимая проверка расписания,
изменённых задач/inputs/model, плохих durations/hash/параметров и consent.

End-to-end offline: настоящий Python solver → JS validation → Bank planning
artifact → опубликованный Harness → передача output артефакта потомку. Проверены
параллельность без барьера, model options и dispose. Тесты с синтетическими
длительностями не доказывают экономию на реальных задачах.

Следующие интеграции: end-to-end selector → problem, сбор usage/cost и budget
enforcement для DAG, Feedback по проверенным исходам, семь baseline и experiment
runner. Полноценная многокритериальная оптимизация назначения моделей пока не
реализована; текущий шаг сохраняет реальный алгоритм Cmax и соединяет его с DAG.
