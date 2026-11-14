# ADR 0006: host DAG scheduler и отдельный Harness run на узел

Дата: 2026-11-14. Статус: реализовано в feature-ветке этапа 6.
База `main@e1252eb` включает объединённые PR #10 и #11.

Старые serial-order/start-groups теряют перекрытие независимых работ и не
передают результаты. Их семантика сохраняется; вводится отдельный data-only
v3 контракт и пакетный экспорт execution.

Node scheduler отвечает за зависимости, weighted slots, timeout/cancel и
долговечные артефакты. На каждый узел запускает Harness с фиксированным
одиночным agent script. Это позволяет сохранить outputs до допуска потребителя,
не ждать unrelated roots и использовать подтверждённые agent model options.
Цена решения — отдельный PTC run/process на узел; overhead включён во время.

Артефакты — целый текстовый output, input bindings только к прямым зависимостям.
Bank проверяет хеши при чтении. Передача — JSON envelope в prompt, не изменение
workspace. Отказ одного узла блокирует потомков; остальные ветки продолжаются.
Отмена или ошибка orchestration останавливает dispatch и освобождает активные runs.

Долговечный dag/start с уникальным executionId предотвращает повторный dispatch
для той же попытки, в том числе при гонке процессов. Crash не запускает retry.
Независимый evaluator остаётся единственным источником подтверждённого успеха;
completed DAG не завершает Bank attempt. Недостающий API accounting не выдумывается.

Следствия и ограничения: concurrency локальна одному DAG, slots логические,
модельные overrides не проверяются у реального провайдера. Нет автоматических
бюджетных резервов, CPU/RAM isolation, patch application, двоичных inputs или
перевода Python расписания в v3. Это явные последующие интеграции, а не свойства
текущего scheduler. Контракт и lifecycle: [DAG Executor](../dag-executor.md).
