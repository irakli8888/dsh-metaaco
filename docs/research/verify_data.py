"""Verify the publication dossier's reduced evidence tables without network or LLMs."""
import hashlib
import json
from collections import Counter
from pathlib import Path

root = Path(__file__).parent
summary = json.loads((root / 'data/summary.json').read_text())
for name, expected in summary.items():
    path = root / 'data' / (name + '.jsonl')
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert len({row['route'] for row in rows}) == len(rows), name
    assert len(rows) == expected['rows'], name
    assert dict(Counter(row['state'] for row in rows)) == expected['states'], name
    assert sum(row['calls'] for row in rows) == expected['calls'], name
    assert sum(row['knownMicrounits'] for row in rows) == expected['knownMicrounits'], name
    assert sum(row['costMicrounits'] is None for row in rows) == expected['incompleteCosts'], name
    assert all(row['costMicrounits'] is None or row['costMicrounits'] == row['knownMicrounits'] for row in rows), name
    print(name, len(rows), dict(Counter(row['failureCategory'] for row in rows)))

original = [json.loads(line) for line in (root / 'data/exhaustive-v1.jsonl').read_text().splitlines()]
corrected = [json.loads(line) for line in (root / 'data/components-v2.jsonl').read_text().splitlines()]
combined = [row for row in original if all(task['id'] != 'implement-stock' for task in row['tasks'])] + corrected
assert len(combined) == 1836
assert len({row['route'] for row in combined}) == 1836
assert sum(row['state'] == 'succeeded' for row in combined) == 1685
replay = json.loads((root / 'data/search-replay.json').read_text())
assert len(replay['runs']) == 10
assert Counter(row['route'] for row in replay['runs']) == {'route-0001': 8, 'route-0011': 1, 'route-0069': 1}
assert all(row['evaluations'] == 100 for row in replay['runs'])
for line in (root / 'data/SHA256SUMS').read_text().splitlines():
    expected_hash, name = line.split('  ', 1)
    assert hashlib.sha256((root / 'data' / name).read_bytes()).hexdigest() == expected_hash, name
cold = json.loads((root / 'data/cold-start-summary.json').read_text())
audit = json.loads((root / 'data/cold-start-audit.json').read_text())
assert len(cold['rows']) == 700
assert len({(r['mode'], r['seed'], r['round']) for r in cold['rows']}) == 700
assert all(r['historyCount'] == r['round'] for r in cold['rows'])
assert len(audit['cells']) == 35 and all(c['records'] == 20 for c in audit['cells'])
assert len(audit['failures']) == 26
assert Counter(n['category'] for f in audit['failures'] for n in f['failedNodes']) == {
    'green-gate': 11, 'snapshot-schema': 12, 'json-syntax': 3}
assert len({r['routeId'] for r in cold['rows']}) == 128
for cell in audit['cells']:
    records = [r for r in cold['rows'] if (r['mode'], r['seed']) == (cell['mode'], cell['seed'])]
    assert len(records) == 20
    assert set(cell['routeIds']) == {r['routeId'] for r in records}
    assert cell['successCount'] == sum(r['verifiedSuccess'] for r in records)
print('Evidence tables, cold-start audit and checksums verified')
