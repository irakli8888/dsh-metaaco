"""Select from a bounded, explicit set of DAG and model variants."""
import argparse
import contextlib
import json
from pathlib import Path
import sys

from metaaco_dag import fields, identifier, integer, plan_dag, validate_problem


def choose_variant(variants, required_tasks, budget, source, seed=42, *, include_schedules=False):
    integer(budget, minimum=0)
    if not isinstance(required_tasks, list) or not required_tasks:
        raise ValueError('Expected required task IDs')
    for task in required_tasks:
        identifier(task)
    if not isinstance(variants, list) or not 1 <= len(variants) <= 16:
        raise ValueError('Expected 1–16 explicit variants')
    seen = set()
    evaluated = []
    feasible = []
    for variant in variants:
        fields(variant, ['id', 'problem', 'costMicrounits'])
        name = variant['id']
        identifier(name)
        if name in seen:
            raise ValueError('Duplicate variant ID')
        seen.add(name)
        cost = variant['costMicrounits']
        integer(cost, minimum=0)
        problem = validate_problem(variant['problem'])
        ids = {task['id'] for task in problem['plan']['tasks']}
        reason = ('missing-required-task' if not set(required_tasks) <= ids
                  else 'over-budget' if cost > budget else None)
        row = {'id': name, 'estimatedCostMicrounits': cost, 'rejected': reason}
        evaluated.append(row)
        if reason is None:
            feasible.append((row, problem))
    if not feasible:
        raise ValueError('No feasible variant')
    best = None
    for row, problem in feasible:
        schedule = plan_dag(problem, source, seed)
        if include_schedules:
            row['schedule'] = schedule
        makespan = schedule['estimates']['scheduleMakespan']
        row['estimatedMakespanSeconds'] = makespan
        score = (makespan, row['estimatedCostMicrounits'], row['id'])
        if best is None or score < best[0]:
            best = score, schedule
    return {'schemaVersion': 1, 'selectedId': best[0][2], 'schedule': best[1],
            'variants': evaluated}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--problem', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).parent / 'vendor')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--include-schedules', action='store_true')
    args = parser.parse_args()
    spec = json.loads(args.problem.read_text(encoding='utf-8'))
    fields(spec, ['schemaVersion', 'variants', 'requiredTasks', 'budgetMicrounits'])
    if type(spec['schemaVersion']) is not int or spec['schemaVersion'] != 1:
        raise ValueError('Expected variant problem v1')
    with contextlib.redirect_stdout(sys.stderr):
        result = choose_variant(spec['variants'], spec['requiredTasks'],
                                spec['budgetMicrounits'], args.source, args.seed, include_schedules=args.include_schedules)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
