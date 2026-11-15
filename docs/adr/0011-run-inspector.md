# ADR 0011: Read-only inspection snapshots

2026-11-15. Context: execution summaries concealed important distinctions between
fixed DAG scheduling, API latency probes and independently evaluated code.

Decision: read explicit SQLite banks with readOnly=true and verified attached
artifacts into a private standalone HTML snapshot. No new dependencies, HTTP
service, network configuration changes or workflow controls. Use existing
contracts; do not migrate banks. Show recorded facts, missing evidence and
inconclusive quality explicitly. Preserve original outputs as text, never execute
model HTML or JavaScript. Keep user data outside Git.

Consequence: available immediately for legacy runs on Lenovo, with manual snapshot
refresh. No live streaming, full ant trace or exact historical HTTP prompt can be
claimed. Those require separate instrumentation. Source paths and prompts in the
snapshot are private data, not a public report.
