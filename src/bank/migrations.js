/** Schema changes run under the same writer transaction as user_version. */
export const migrations = [
  `CREATE TABLE strategies (
    strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
    definition TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (strategy_id, version)
  ) STRICT;
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, request TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE attempts (
    attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
    strategy_id TEXT NOT NULL, strategy_version INTEGER NOT NULL,
    selection TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','inconclusive','cancelled','interrupted')),
    started_at TEXT NOT NULL, finished_at TEXT,
    evaluation TEXT, outcome TEXT, reason TEXT,
    FOREIGN KEY(strategy_id, strategy_version) REFERENCES strategies(strategy_id, version),
    CHECK ((state = 'running' AND finished_at IS NULL) OR (state != 'running' AND finished_at IS NOT NULL))
  ) STRICT;
  CREATE INDEX attempts_task ON attempts(task_id);
  CREATE INDEX attempts_strategy ON attempts(strategy_id, strategy_version);
  CREATE TABLE events (
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, recorded_at TEXT NOT NULL, event TEXT NOT NULL,
    PRIMARY KEY(attempt_id, event_id), UNIQUE(attempt_id, sequence)
  ) STRICT;
  CREATE TABLE artifacts (
    sha256 TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0)
  ) STRICT;
  CREATE TABLE attempt_artifacts (
    attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), name TEXT NOT NULL,
    sha256 TEXT NOT NULL REFERENCES artifacts(sha256),
    PRIMARY KEY(attempt_id, name)
  ) STRICT;`,
]
