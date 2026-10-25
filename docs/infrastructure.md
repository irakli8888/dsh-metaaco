# Инфраструктура, доступ и проверка окружения

## Статус сведений на 2026-10-25

| Объект | Сведения | Статус |
|---|---|---|
| Основная рабочая станция | Mac ARM64 | arm64 подтверждён локально |
| Проект Work dsh-metaaco | `/Users/iraklijkvacahia/IdeaProjects/dch-metaaco` | Найден в списке проектов; каталог и remote прочитаны |
| GitHub | `https://github.com/irakli8888/dsh-metaaco` | Доступ подтверждён; main получен, база 08e0a1e |
| Внешний MetaACO | `/Users/iraklijkvacahia/PycharmProjects/metaACOwithCodex` | Код доступен для чтения, снимок описан в metaaco-algorithm.md |
| Сервер | Lenovo 82JU, Ryzen 5 5600H 6C/12T, 16GB DDR4, NVMe 512GB | Сообщено владельцем, удалённо не проверено |
| ОС сервера | Windows, WSL2 Ubuntu 26.04.1 | Сообщено владельцем, не проверено |
| Среда WSL | Python 3.14.4, OpenJDK 21.0.12.1, Docker 29.1.3, git, OpenSSH, Tailscale; пользователь irakli | Сообщено владельцем, версии/службы не проверены |
| Docker Compose | Ранее отсутствовал | Текущее наличие неизвестно; отдельно проверить plugin `docker compose` |
| agent-lab | agents/, docker/, experiments/, harness/, metaaco/, projects/, results/, compose.yaml | Ожидаемая структура, наличие и абсолютный путь не подтверждены |

Название каталога `dch-metaaco` отличается от названия проекта и репозитория
`dsh-metaaco`; не исправлять его автоматически. Локальный checkout был чистым,
но находился на более новой feature-ветке с незамёрженными в базу main возможностями.
Документация готовится из копии репозитория в отдельной ветке; исходный checkout
не переключается и не перезаписывается.

У этого запуска есть чтение исходников Mac. Это не означает, что будущий cloud-агент,
контейнер или WSL получит доступ к тем же путям. Для сервера нет подтверждённого
endpoint/IP и проверенного SSH-профиля в контексте задачи. SSH-подключение не выполнено;
доступность сервера, службы, установленные версии и agent-lab не подтверждены.
Отсутствие проверки не означает отсутствия ПО. Не угадывать сетевой адрес.

## Существующая схема доступа (по сведениям владельца)

```text
Mac → Tailscale Windows IP : TCP 2222 → Windows portproxy/firewall → WSL : TCP 22
                                                                       user: irakli
```

В Windows настроена задача «WSL Agent Server». Её существование, параметры,
последний результат, актуальность WSL IP и portproxy требуют проверки.
Не менять маршруты, firewall, portproxy, SSH, задачу планировщика или настройки
Tailscale. Не публиковать IP, ключи и прочие реквизиты в документации или логах PR.

## Диагностика без изменения конфигурации

Ниже инструкции будущей проверки, а не журнал выполненных команд.
Подключаться только через уже подтверждённый владельцем endpoint/SSH alias.
Не отключать проверку host key и не копировать приватные ключи на сервер.

В Windows PowerShell, при наличии необходимых прав на чтение:

```powershell
wsl --version
wsl --list --verbose
netsh interface portproxy show all
Get-NetTCPConnection -LocalPort 2222 -State Listen
Get-ScheduledTask -TaskName 'WSL Agent Server'
Get-ScheduledTaskInfo -TaskName 'WSL Agent Server'
Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq '2222' } | Get-NetFirewallRule
tailscale status
```

В уже открытой WSL-сессии:

```sh
whoami
cat /etc/os-release
uname -m
python3 --version
java -version
git --version
ssh -V
systemctl is-active ssh
ss -ltn 'sport = :22'
docker --version
docker info
docker compose version
tailscale version
```

Tailscale может быть установлен на Windows, а не внутри WSL: отсутствие команды
в WSL не опровергает доступ через Tailscale Windows. `docker --version` проверяет
клиент; `docker info` — доступ к daemon; `docker compose version` — Compose plugin.
Их ошибки записывать раздельно, ничего не устанавливать автоматически.

После получения реального расположения agent-lab перейти в него и проверить:

```sh
pwd
ls -ld agents docker experiments harness metaaco projects results
test -f compose.yaml
```

Не считать `/home/irakli/agent-lab` подтверждённым путём только из имени пользователя.
После проверки Compose допустима локальная валидация `docker compose config --quiet`:
она не запускает сервисы. Не выводить развёрнутую конфигурацию с секретами в PR.
Не выполнять compose up, pull образов или настройку доступа в рамках документационной задачи.

## Размещение и воспроизводимость

Предполагаемые роли каталогов, если структура подтвердится: `agents/` — профили,
`docker/` — окружения, `experiments/` — manifests, `harness/` — Harness,
`metaaco/` — отдельная закреплённая копия solver, `projects/` — рабочие репозитории,
`results/` — результаты, `compose.yaml` — описание сервисов. Это назначение,
а не подтверждение содержимого или готовности к запуску.

На Mac и сервере исходники solver закреплять commit либо полным manifest хешей;
не импортировать Mac-путь из WSL. Репозиторий orchestration и внешний Python-проект
имеют независимые версии. Не переносить .venv между ОС/архитектурами; ARM64 и x86_64
зависимости и образы проверять отдельно. Java не является подтверждённой runtime-зависимостью
текущего Node/Python-моста только потому, что установлена на сервере.

package.json текущей базы требует Node >=24.9 и Harness `0.2.1-rc.2`; наличие Node
на сервере ещё не проверено. Python/Java/Docker версии из сообщения владельца
не доказывают совместимость с кодом. Сначала offline smoke/contract tests, затем
отдельно разрешённые эксперименты по [протоколу](architecture.md).
Сохранять локальные runtime version, lockfile, test reports, конфигурации и квоты.

Ресурсы сервера ограничены: подбирать concurrency измерениями, оставляя запас WSL,
Docker и evaluator; 12 потоков CPU не означают 12 допустимых LLM-агентов.
Предусмотреть лимиты CPU/RAM/disk и безопасную изоляцию тестируемого кода при реализации.
Секреты держать вне Git, результаты очищать от реквизитов; резервировать банк и
артефакты до миграций. Сетевые и системные изменения требуют отдельной задачи.
