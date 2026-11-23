"""Offline research audit: capture the production DAG decoder; no solver or API calls.
Run from repo root: python3 -B docs/research/data/enumerate-reference-space.py
"""
import hashlib
import itertools
import json
import sys
from collections import Counter
from pathlib import Path

root = Path.cwd()
sys.path.insert(0, str(root / 'python'))
import skill_decisions

models = ['deepseek-flash', 'deepseek-v4-pro']
resources = {'agentSlots': 2, 'timeoutMs': 300000, 'maxArtifactBytes': 65536, 'maxInputBytes': 262144}
skills = ['implement', 'refactor', 'design', 'integrate', 'analyze', 'review', 'write-tests',
          'implement-a', 'implement-b', 'implement-c']


def capture(groups, build, budget, **options):
    routes = {}
    rejected = 0
    for values in itertools.product(*groups.values()):
        choices = dict(zip(groups, values))
        candidate = build(choices)
        if candidate is None:
            rejected += 1
            continue
        problem, _ = candidate
        identity = sorted([[t['id'], t['model']['provider'], t['model']['model'], sorted(t['dependsOn'])]
                           for t in problem['plan']['tasks']])
        key = json.dumps(identity, separators=(',', ':'))
        routes.setdefault(key, {'layout': choices['layout'], 'route': identity})
    ordered = [routes[k] for k in sorted(routes)]
    return {'rawAssignments': __import__('math').prod(map(len, groups.values())),
            'rejectedAssignments': rejected, 'uniqueRoutes': len(routes),
            'byLayout': dict(Counter(r['layout'] for r in ordered)),
            'modelCallsUpperCount': sum(len(r['route']) for r in ordered),
            'routeCatalogSha256': hashlib.sha256((''.join(json.dumps(r, sort_keys=True, separators=(',', ':')) + '\n' for r in ordered)).encode()).hexdigest(), 'routes': ordered}


original = skill_decisions.search_workflow
try:
    skill_decisions.search_workflow = capture
    results = {}
    for name, names in [('full', skills), ('bounded', [s for s in skills if s not in ('analyze', 'write-tests')])]:
        catalog = {s: [{'model': {'provider': 'deepseek', 'model': m}, 'prompt': s,
                        'seconds': 10, 'costMicrounits': 0} for m in models] for s in names}
        results[name] = skill_decisions.plan_skill_graph(catalog, resources, 0, component_design_required=True)
finally:
    skill_decisions.search_workflow = original

assert results['full']['byLayout'] == {'components': 1728, 'monolith': 540}
assert results['bounded']['byLayout'] == {'components': 192, 'monolith': 36}
assert results['bounded']['modelCallsUpperCount'] == 1400
catalog = {'schemaVersion': 1, 'kind': 'structural-enumeration-not-observed-performance',
           'sourceBase': '3a696b4abd717c694c2fbeb12198c4812c45f97d',
           'decoderSha256': hashlib.sha256((root / 'python/skill_decisions.py').read_bytes()).hexdigest(),
           'resources': resources, 'models': models,
           'notes': ['No API, solver search or quality estimation executed.',
                     'Synthetic zero-cost route entries enumerate structure only; not prices.',
                     'Identity excludes inactive choices and independent-node dispatch priorities.'],
           'full': {k: v for k, v in results['full'].items() if k != 'routes'},
           'bounded': results['bounded']}
path = root / 'docs/research/data/exhaustive-reference-v1-space.json'
path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: {f: v for f, v in x.items() if f != 'routes'} for k, x in results.items()}))
