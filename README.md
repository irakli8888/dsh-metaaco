# dsh-metaaco — минимальный плагин для DeepSeek Harness 0.2.1-rc.2

Добавлен первый этап согласованной архитектуры: [локальный Strategy Bank на SQLite](docs/strategy-bank.md) для immutable версий стратегий, истории попыток, событий и артефактов. Он доступен отдельным API `dsh-metaaco/bank`. См. [архитектурный план](docs/architecture-audit.md) и [ADR](docs/adr/0001-strategy-bank.md).

Второй этап: [независимый TDD Evaluator](docs/tdd-evaluator.md), API `dsh-metaaco/evaluation`, запускает закреплённые Node tests по фазам baseline/RED/GREEN/REFACTOR и сохраняет собственные отчёты в Bank. Это локальный adapter для доверенного кода; универсальная изоляция, другие test runners и полный Metrics Collector ещё не реализованы. [Офлайн-пример](examples/tdd-evaluation.js) не обращается к LLM.

Программный запуск фиксированного workflow из JSON. Расписание задаёт человек: стадии идут последовательно, дети внутри стадии запускаются параллельно (с учётом лимита движка). Родительская LLM не выбирает расписание и не пишет скрипт. Исполнитель не содержит оптимизатора ACO, автоматического перепланирования и передачи результатов между стадиями. Для внешнего настоящего Python MetaACO добавлен [адаптер и версионированный JSON-контракт](docs/python-planner.md): Python планирует, Harness исполняет группы работ с одинаковым временем старта параллельно, с ожиданием завершения между группами; прежний последовательный режим также поддерживается.

Для агентных задач доступен [JSON-вход с ресурсом «слот агента»](docs/agent-resources.md): задайте зависимости, оценочные длительности в секундах и лимит одновременно работающих агентов. Адаптер вызывает настоящий Python MetaACO и выдаёт план v2 с лимитом слотов и отдельными оценками времени для исходного расписания и исполнения группами.

## Установка в ~/agent-lab

В среде сборки каталога `~/agent-lab` не было. Перенесите папку этого пакета на машину проекта, например в `~/agent-lab/plugins/dsh-metaaco`. Существующие конфигурации проектa автоматически не менялись.

Требуется Node.js >=24.9 и Harness **0.2.1-rc.2**. Команды установки и тесты ниже не обращаются к LLM:

```sh
cd ~/agent-lab/plugins/dsh-metaaco
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm test:integration
```

Интеграционные тесты используют настоящий опубликованный `dsh-workflow-ptc@0.2.1-rc.2`, настоящий PTC Node runtime и registry subagents, но фиктивный провайдер `offline`. Он создаёт два provider-run, возвращает заранее заданные ответы, проверяет parent, события и dispose. Это не проверка качества ответов модели и не запуск двух реальных LLM. LLM-адаптер и ключи тесту не нужны. Для доверенного фиксированного скрипта тест использует `danger-full-access` в своей временной директории; это не настройка рабочего профиля.

## Подключение и запуск из интерфейса

Slash-команду следует вызывать через интерактивный профиль, например `web`. Передача строки `/metaaco` обычным prompt в `headless` не заменяет вызов command registry.

1. Если профиль `web` ещё не создан, один раз откройте его командой `npx --yes @deepseek-ai/dsh@0.2.1-rc.2 web`, затем остановите. Само открытие интерфейса не отправляет задачу модели.
2. Установите локальный пакет в профиль:

```sh
cd ~/agent-lab
npx --yes @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile web add ./plugins/dsh-metaaco
```

3. В `$DSH_HOME/profiles/web/cordis.patch.yml` (обычно `~/.dsh/profiles/web/cordis.patch.yml`) добавьте элемент к существующему YAML-списку. Подставьте абсолютный Linux-путь к проекту:

```yaml
- insert:
    - id: metaaco
      name: dsh-metaaco
      config:
        workflowFile: /home/irakli/agent-lab/plugins/dsh-metaaco/examples/two-agents.json
        subagentProvider: spawn
```

Профиль должен предоставлять `commands`, `workflowEngine` (реализация workflow-ptc), PTC Node runtime и subagent provider `spawn`. В базовой композиции Harness они уже есть; не добавляйте дубликаты. Проверить композицию без запуска модели:

```sh
npx --yes @deepseek-ai/dsh@0.2.1-rc.2 --profile web --dump-config
```

Если ваш профиль их отключает, восстановите соответствующие записи: `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-subagent-spawn-in-process` с `providerName: spawn`, `@deepseek-ai/dsh-ptc-runtime-node`, `@deepseek-ai/dsh-workflow-ptc` с `provider: spawn`, вместе с их обычными зависимостями из базового профиля. Модель детям наследуется от parent; отдельный родительский LLM-запрос для запуска не требуется. Права и доступные инструменты детей определяет рабочий профиль.

4. Запустите интерфейс из каталога проекта:

```sh
cd ~/agent-lab
npx --yes @deepseek-ai/dsh@0.2.1-rc.2 web
```

В чате введите `/metaaco`: это только предварительный просмотр JSON и количества детей, без запуска engine. Для разрешённого вами реального запуска введите **`/metaaco --allow-llm`**. Этот флаг является явным согласием на модельные запросы дочерних агентов; они могут быть платными. В ходе разработки такой запуск не выполнялся.

## JSON и результат

См. `examples/two-agents.json`: одна стадия `Research`, два независимых ребёнка `java` и `aco`. Чтобы добавить последовательную стадию, добавьте следующий элемент в `stages`. Все `title` стадий и `id` детей должны быть уникальны. Произвольные поля и JavaScript в JSON запрещены. Промпты передаются как строки, а не вставляются в исполняемый код.

Успех возвращает `{ runId, agentsStarted, result: { java: "...", aco: "..." } }`. Ошибка ребёнка (engine возвращает `null`) останавливает последующие стадии. Частичный результат не выдаётся как успех. При отмене вызывается `run.cancel()`; на любом исходе ожидается `run.dispose()`. Повторные одновременные команды создают отдельные запуски; дедупликации и сохранения для возобновления нет.

Лимит `maxTotalAgents` равен числу детей JSON. Он ограничивает прямые `agent()` этого workflow, а не число модельных шагов и не дальнейшую делегацию внутри ребёнка. Для строгого запрета вложенной делегации ограничьте инструменты/глубину детей в профиле.

## Программный API и проверенные сигнатуры

Для интеграции с собственным доверенным обработчиком можно вызвать:

```js
import { runWorkflow } from 'dsh-metaaco'
// parent — уже существующий живой Agent, workflow — прочитанный JSON.
const result = await runWorkflow(ctx, parent, workflow, {
  signal,
  subagentProvider: 'spawn',
})
```

`runWorkflow()` исполняет сразу; получение явного разрешения на реальные LLM-вызовы здесь лежит на вызывающем приложении. CLI-бина, самостоятельно создающего родителя, у пакета нет: запуск приложения остаётся через профиль `dsh`.

Проверены декларации и реализация **npm-пакетов 0.2.1-rc.2**, а не только текущий GitHub HEAD:

- `WorkflowEngine.start(request): WorkflowRun` — синхронный метод. Request содержит `script`, `meta`, `args?`, обязательный `parent: Agent`, `subagentProvider?`, `maxTotalAgents?`, `signal?`.
- Run предоставляет `result: Promise<WorkflowResult>`, `cancel(reason?)`, `dispose(): Promise<void>`. У результата поля `stopReason`, `value`, `agentsStarted`, `error?`; `stopReason` — `completed | cancelled | error`.
- `CommandInvocation.agent` — настоящий принимающий Agent; обработчик команды исполняется без отправки её модели. Плагин использует именно его. У контекста нет предполагаемого `ctx.agent`.
- У model-facing инструмента workflow parent берётся из `exec.agent`; это другой путь вызова, который этому плагину не нужен.

Источники: [репозиторий Harness](https://github.com/deepseek-ai/deepseek-harness), [workflow 0.2.1-rc.2](https://www.npmjs.com/package/@deepseek-ai/dsh-workflow/v/0.2.1-rc.2), [commands 0.2.1-rc.2](https://www.npmjs.com/package/@deepseek-ai/dsh-commands/v/0.2.1-rc.2), [tool-workflow 0.2.1-rc.2](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-workflow/v/0.2.1-rc.2). Исследованный открытый checkout: `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; совместимость установлена отдельным тестом на опубликованных пакетах. Интерактивная установка на исходной Linux-машине не проверялась.
