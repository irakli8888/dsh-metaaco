# ADR 0003: наблюдения, расчёт стоимости и общий admission ledger

Дата 2026-10-25, база main@cc8df28. Это третий этап принятой архитектуры; optimizer/selector не изменяются.

## Решения

1. Метрики — projection persistent events существующего Bank, а не отдельная in-memory статистика. Одна read transaction закрепляет события и accounting corrections. Запись metrics events атомарно защищает finish, idempotency и monotonic clock order. Прогнозы не смешиваются с измерениями.
2. Длительности используют process-local monotonic clockId. Перезапуск с новым clockId не создаёт фиктивную длительность из UTC. Известны суммы и union наблюдаемых интервалов; наблюдения PTC помечаются как время доставки observer, а не точные provider timestamps.
3. ModelCallRecord — один физический вызов. Pricing snapshot фиксирует provider/model/revision, дату, источник, валюту и четыре непересекающихся тарифа. Встроенных коммерческих цен нет. BigInt arithmetic и ceiling до microunit за вызов исключают ошибки floating-point денег. total/reasoning не складываются второй раз.
4. Полнота охвата объявляется явно и по умолчанию отсутствует. Missing usage и unpriced calls дают null и причины; известные нижние суммы доступны отдельно. Не все Harness calls имеют durable settlement, поэтому live observer не утверждает полный охват.
5. Late provider billing — append-only correction, доступная после terminal state. Старый AttemptRecord и оценка качества immutable. Accounting revisions и все записи попадают в JSONL; это не переписывание предшествующего научного результата.
6. Shared budget хранится в тех же SQLite transactions. Резервирование и сверка разделены. Неизвестный счёт не освобождает деньги; исторический upper-bound breach блокирует budget. Dispatch wrapper не повторяет операцию по существующему reservationId и требует explicit allowLlm. Он не является глобальным перехватчиком Harness: жёсткая гарантия возможна только при полном instrumented dispatch и подтверждённой верхней границе.

## Проверка реальных интерфейсов

Прочитаны установленные 0.2.1-rc.2: dsh-llm TokenUsage/AssistantStreamRecord, dsh-session session/event и assistant/message/assistant/attempt, dsh-agent AgentOptions/registry, workflow-ptc публикация agent-start/end. TokenUsage явно задаёт uncached input отдельно от cache read/write. Embedded raw usage chunks сохраняются непакованными; для одной settlement используется последнее значение, а data.usage при наличии имеет приоритет.

Проверенный offline engine создаёт настоящий workflow и публикует настоящие session events с синтетическими счётчиками. Provider не вызывает модель. Adapter буферизует usage, поступивший до workflow child-start, сопоставляет его по childId и не записывает тексты промптов. Нельзя создавать external child Session до допуска его ID registry: тест публикует session после admission. Это поведение проверено на установленной версии, а не предположение о будущем Harness.

## TDD и ограничения

Первоначальная минимальная реализация возвращала unknown cost, и 8 новых сценариев упали до реализации (целевой assertion на цене 22 microunits, отсутствующие span/budget APIs). После projection/pricing/ledger они проходят. Отдельные дополнительные RED показали пропуск нарушения upper bound, противоречивого total и отсутствие метрик evaluator; после патчей проверки проходят. Проверяется и отказ без согласия до dispatch, защита от повторного dispatch, межпроцессная конкуренция, replay, unknown usage, валюты, overflow и late billing без изменения terminal outcome.

Полный охват compaction/abandoned calls, global Harness hard-budget enforcement, реальное provider latency/requestId и учёт ресурсов CPU/RAM не заявлены. Для provider hooks, отсутствующих в установленном составе, сохранён явный recordCall API, без выдумывания события. Никакие платные эксперименты, установки ПО и инфраструктурные изменения не выполнялись.
