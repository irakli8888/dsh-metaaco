# ADR 0007: проверенная проекция MetaACO в приоритеты DAG

Дата: 2026-11-14. Статус: реализовано в feature-ветке этапа 7.
База: DAG Executor `7d10f43`, открытый PR #12.

Существующий bridge выдаёт serial-order/start-groups. Они не выражают
artifact bindings и не подходят для нового DAG без изменения смысла контрактов.

Добавляем отдельный problem v2 и CLI, вызывающий реальный ColonyManager.
Сохраняем многоколониальность, UCB, репликацию мутациями, элитный архив и local
search; ресурсный demand равен task.slots. Оценки bounded, исходники не копируются.
Из-за time-indexed SSGS ограничиваем сумму длительностей до 86400 секунд.

Расписание используется как приоритет готовых задач, а не как искусственные
зависимости/таймеры. Так сохраняются исходный DAG и явные bindings. Cmax solver
остаётся прогнозом отдельной модели; executionMakespan=null. При runtime drift
исполнитель реагирует на фактическое завершение задач.

Python валидирует реальное расписание core.validate_schedule/order; JS независимо
проверяет precedence, resources, Cmax и неизменность задачи по originalProblem.
Provenance фиксирует вход, seed, bounded параметры, bridge/source hashes и Python.
Bank сохраняет envelope как planning artifact до запуска Harness.

Последствия: solver objective не превращается в деньги/качество, проекция не
гарантирует сохранения Cmax, а hashes не аттестуют происхождение. Контракты
исполнения v1/v2/v3 остаются неизменными. Full orchestration/Feedback и ресурсный
API accounting добавляются отдельно. Детали: [MetaACO → DAG](../metaaco-dag.md).
