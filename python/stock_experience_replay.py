"""Replay the skill search against frozen observations of the same training task."""
import argparse
import json
import math
import statistics
from pathlib import Path

from skill_decisions import plan_skill_graph


def route_key(tasks):
    return json.dumps(sorted(
        [[task['id'], task['model']['provider'], task['model']['model'], sorted(task['dependsOn'])]
         for task in tasks]), ensure_ascii=False)


def replay(rows, seeds=10):
    observed = {route_key(row['plan']['tasks']): row for row in rows}
    if len(rows) != 1836 or len(observed) != 1836:
        raise ValueError('Expected 1836 unique frozen training observations')
    timings = {}
    prompts = {}
    for row in rows:
        models = {task['id']: task['model']['model'] for task in row['plan']['tasks']}
        for task in row['plan']['tasks']:
            prompts[(task['id'], models[task['id']])] = task['prompt']
        for node in row['nodes'] or []:
            if node['state'] == 'completed' and node['wallTimeMs'] is not None:
                timings.setdefault((node['id'], models[node['id']]), []).append(node['wallTimeMs'])
    catalog = {}
    for (skill, model), prompt in sorted(prompts.items()):
        values = timings.get((skill, model))
        if not values:
            raise ValueError('Missing node timing evidence')
        catalog.setdefault(skill, []).append({
            'model': {'provider': 'deepseek', 'model': model}, 'prompt': prompt,
            'seconds': max(1, math.ceil(statistics.median(values) / 1000)),
            'costMicrounits': 301229 if model == 'deepseek-flash' else 1324056})
    evidence = [{'route': json.loads(key), 'attempts': 1, 'successes': int(row['verified'])}
                for key, row in observed.items() if row['verified'] or row['testFailure']]
    runs = []
    for seed in range(seeds):
        result = plan_skill_graph(catalog, rows[0]['plan']['resources'], 11916504,
                                 quality_evidence=evidence, seed=seed)
        selected = observed[route_key(result['problem']['plan']['tasks'])]
        runs.append({'seed': seed, 'route': selected['route'], 'historicalState': selected['state'],
                     'historicalWallTimeMs': selected['wallTimeMs'],
                     'historicalCostMicrounits': selected['costMicrounits'],
                     'evaluations': result['evaluations'], 'choices': result['choices'],
                     'problem': result['problem'], 'trace': result['trace']})
    return {'schemaVersion': 1, 'mode': 'same-task-frozen-training-replay',
            'observedRoutes': len(observed), 'qualityEvidenceRoutes': len(evidence),
            'timingSource': 'median measured node wall time rounded up to seconds; forecast',
            'runs': runs}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('experience', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    args.out.write_text(json.dumps(replay(json.loads(args.experience.read_text())), indent=2))
