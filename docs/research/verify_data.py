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
print('Evidence tables and checksums verified')
