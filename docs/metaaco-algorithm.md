# Существующий Python MetaACO

## Происхождение и границы проверки

2026-10-25 исходники на Mac прочитаны непосредственно по пути
`/Users/iraklijkvacahia/PycharmProjects/metaACOwithCodex`.
Основные проверенные файлы: `rcpsp/core.py`, `rcpsp/metaACO.py`;
также доступны `baseline_aco.py`, `experiment_worker.py`, `run_experiments.py`,
`run_experiments2.py`, `references.py`, `analyze_results.py`, `tests/test_rcpsp.py`,
каталоги PSPLIB и сохранённых экспериментов. Результаты старых экспериментов
не являются доказательством эффективности для задач программирования.

SHA-256 прочитанного снимка:

```text
rcpsp/core.py
a272ca88bf08661a50f7acb9d4affff6657012ffb9ccfeb353dee58761bc9099
rcpsp/metaACO.py
32e2bc402159bbae091b88fb19784025cbe87ff98034eea6396cbee180dc45c1
```

Снимок внешнего проекта не входит в этот репозиторий и автоматически не закрепляется
его commit. При последующей работе пересчитать хеши всего импортируемого кода.
Путь Mac недоступен автоматически в WSL, контейнере или cloud-агенте.

Исторический контекст владельца: RCPSP/RCMPSP, минимизация Cmax, SSGS и PSPLIB.
Проверенный `core.py` прямо описывает single-mode RCPSP с возобновляемыми ресурсами.
Отдельный интерфейс multi-project RCMPSP, многорежимность и ограничения
невозобновляемых ресурсов этим просмотром не подтверждены. Не заявлять такую поддержку.

## Реальные классы и функции

| Модуль / символ | Проверенный интерфейс и назначение |
|---|---|
| `core.RcpspInstance` | dataclass: `n_jobs, n_renewable, durations, demands, capacities, successors, predecessors`; проверка размеров, ресурсов и DAG |
| `core.Schedule` | dataclass: `start_times, makespan, order=None` |
| `core.topological_order(inst, priorities=None)` | Порядок Кана; приоритеты разрешают выбор среди доступных работ |
| `core.validate_order(inst, order)` | Перестановка всех работ с соблюдением зависимостей |
| `core.validate_schedule(inst, schedule)` | Независимая проверка Cmax, предшествований и ресурсов sweep-проходом |
| `core.EvaluationBudget(limit=None, time_limit=None)` | Учёт оценок и времени, `start`, `consume`, `record`, `exhausted`, `stop_reason` |
| `core.SerialScheduleGenerator(budget=None)` | `generate(inst, order, category="aco") -> Schedule`: SSGS |
| `core.load_psplib_instance(path)` | Загрузка PSPLIB в `RcpspInstance` |
| `metaACO.ColonyParams` | alpha, beta, rho, q0, heuristic_type, веса эвристик, ls_iters, ls_prob; `random_init(rnd)`, `mutate(rnd)` |
| `metaACO.PheromoneMatrix` | Феромоны по паре позиция/работа; `get`, `evaporate`, `deposit_on_order` |
| `metaACO.Ant` | `construct_order() -> List[int]`: выбор допустимых работ |
| `metaACO.AntColony` | `run_iteration(n_ants) -> (Optional[Schedule], float)`; собственные феромоны и лучший результат |
| `metaACO.EliteEntry / EliteArchive` | Ограниченный архив расписаний; `add(schedule)`, `best()` |
| `metaACO.ColonyBanditController` | `add_colony`, `select_colony_index`, `update(idx, reward)`; выбор вычислительного бюджета между колониями |
| `metaACO.ColonyManager` | `init_random_colonies(k)`, `run(iterations, ants_per_iteration, improvement_threshold=0.02)` возвращает `(Optional[Schedule], Optional[AntColony])` |
| `metaACO.solve_rcpsp_psplib` | Обёртка PSPLIB, возвращает `(Schedule, ColonyParams)`; при отсутствии решения RuntimeError |

Проверенная сигнатура обёртки:

```python
solve_rcpsp_psplib(path, seed=42, init_colonies=3, max_colonies=10,
                  iterations=500, ants_per_iteration=20, max_evaluations=None,
                  replication_enabled=True, elite_enabled=True,
                  local_search_enabled=True)
```

Конструктор `ColonyManager(inst, rnd, ...)` поддерживает `max_colonies=10`,
`ucb_c=1.0`, `elite_capacity=30`, `tau0=0.1`, `max_evaluations=None`,
`replication_enabled=True`, `elite_enabled=True`, `local_search_enabled=True`,
`time_limit=None`, `selection="ucb"`, `discount=1.0`,
`reward_mode="global_improvement"`, `replication_mode="mutate"`, `elite_strength=0.1`.
Не все параметры manager доступны через обёртку PSPLIB.

## Механика

Муравьи строят precedence-feasible перестановку; SSGS декодирует её в допустимое
расписание. Целевая функция — минимизация `Schedule.makespan` (Cmax).
Колонии имеют разные параметры и собственные RNG/феромоны. Многоколониальность
не означает параллельное исполнение: manager выбирает одну колонию на итерацию.

`ColonyBanditController` поддерживает `ucb`, `random`, `round_robin`.
Для UCB после исследования непроверенных колоний используется средняя награда плюс
`c * sqrt(log(total_pulls) / mass)`, с необязательным discount статистики.
Это эмпирический UCB-подобный выбор обучающихся колоний; код явно не обещает
стационарные UCB1 regret bounds. Контекст задачи здесь не является входным вектором
для contextual bandit стратегий.

В `global_improvement` награда — относительное улучшение против предыдущего
глобального best (первое сравнение — последовательный горизонт суммы длительностей).
Альтернатива `quality` использует отношение lower bound к Cmax, ограниченное единицей.
При улучшении выше threshold, наличии бюджета и свободного места создаётся новая
колония. `replication_mode` — `mutate` либо `restart`; это создание нового объекта
колонии, не копирование процесса. События init/pull/replicate сохраняются в `manager.events`.

Элитный архив хранит лучшие расписания и используется для усиления феромонов и
инициализации новых колоний. Это внутрипроцессный банк RCPSP-решений, не постоянный
банк стратегий LLM, ошибок, тестов и стоимости.

Локальный поиск `_local_search_order` пробует обмен двух позиций, отбрасывает
недопустимые порядки и принимает строгое улучшение Cmax. Его оценки учитываются
общим бюджетом. Вероятность запуска задаёт `ls_prob`, число попыток — `ls_iters`.
Независимые RNG-потоки разделяют инициализацию, мутации, выбор колоний и работу колоний.

Проверенные ограничения мутации:

| Параметр | Интервал после mutate |
|---|---|
| alpha | 0.1–3.0 |
| beta | 0.1–6.0 |
| rho | 0.01–0.5 |
| q0 | 0.01–0.99 |
| ls_iters | целое 0–50 |
| ls_prob | 0–1 |

Также мутируются тип эвристики (`min_duration/combo/none`) и нормированные веса
duration/successors/criticality. Диапазоны random_init отличаются от mutate.

## Существующий мост и правила интеграции

В `main@08e0a1e` файл [python/metaaco_plan.py](../python/metaaco_plan.py)
импортирует настоящие `load_psplib_instance`, `solve_rcpsp_psplib`,
`validate_schedule`, `validate_order`. Solver запускается с 20 итерациями,
5 муравьями и лимитом 100 оценок; default seed 42. Диагностика идёт в stderr,
JSON-план — в stdout. Подробности: [python-planner.md](python-planner.md).

План v1 — `python-metaaco` / `serial-order`. `tasks` сопоставляет нулевые индексы
всех работ положительной длительности с `{id, prompt}`; нулевые работы не исполняются.
Внешний solver не копируется и не скачивается автоматически. При недоступности
или несовместимости импортов мост завершается ошибкой, без альтернативного ACO.

В просмотренной более новой локальной ветке есть `build_problem(problem)` и
`plan_problem(problem, seed=42, execution='start-groups')` в `python/agent_problem.py`:
агентная работа занимает один слот, длительность — входной прогноз в секундах;
manager использует 3 начальные колонии и 100 оценок. Это не поддержка моделирования
реальных API-цен или качества самим RCPSP. Перед применением проверить попадание
этой ветки в main и совместимость контрактов.

Для расширения вводить явный адаптер задач программирования к ресурсной модели,
а не переименовывать Cmax в качество/стоимость. Стоимость и качество оценивают
отдельные компоненты; изменение цели solver требует отдельного исследования и тестов.
Перед заявлениями об улучшении применять [экспериментальный протокол](architecture.md).
Не переносить в runtime старые результаты PSPLIB как прогноз эффективности LLM.
