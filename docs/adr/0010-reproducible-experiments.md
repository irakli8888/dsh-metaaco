# ADR 0010: frozen парные эксперименты без подмены алгоритмов

Дата: 2026-11-14. База `main@b896095`, после слияния PR #12–15.

Нужен общий протокол сравнения, исключающий test leakage, различие критериев
успеха и потерю неудачных результатов. Решение: одна immutable конфигурация,
семь явно определённых режимов, одинаковые task/seed пары, frozen Feedback и
тот же independent evaluator. Общая фильтрация допустимости остаётся в Selector;
baseline получает своё имя алгоритма, а его валидно привязанные train-исходы
можно использовать позднее, не выдавая selection за LinUCB.

MetaACO+bank использует LinUCB для arm и реальный solver для порядка задач.
MetaACO without bank использует fixed arm и тот же solver с тем же elite archive.
Это операционные определения ablation, а не новый многокритериальный ACO.

Runner хранит старт каждой ячейки до dispatch в append-only fsynced journal,
результат после завершения, и ссылки на Bank evidence. Ошибки и неизвестные
расходы не исчезают из summary. Перезапуск/paid retry не автоматические. Внешний
deadline включает solver и остаётся timeout в Bank, а не cancelled.

Offline launcher использует синтетические ответы моделей только как fixture,
реальные Harness и MetaACO. Научные выводы по fixture недопустимы. Source hashes
и runtimeConfig обеспечивают идентификацию, не аттестацию доверенной factory;
скрытые API calls/SDK retries остаются ограничением её интеграции. Подробности:
[experiments.md](../experiments.md).
