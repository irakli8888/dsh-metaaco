"""Bridge to the external RCPSP MetaACO implementation; no replacement solver."""
import argparse
import contextlib
import json
import sys


def make_plan(schedule, instance, tasks):
    from rcpsp.core import validate_schedule, validate_order
    validate_schedule(instance, schedule)
    if schedule.order is None:
        raise ValueError('MetaACO must return an explicit precedence-feasible order')
    validate_order(instance, schedule.order)
    expected = {str(j) for j, duration in enumerate(instance.durations) if duration > 0}
    if not isinstance(tasks, dict) or set(tasks) != expected:
        raise ValueError('tasks must map every positive-duration zero-based job index exactly once')
    stages = []
    for job in schedule.order:
        if str(job) not in tasks:
            continue
        task = tasks[str(job)]
        if not isinstance(task, dict) or set(task) != {'id', 'prompt'}:
            raise ValueError('Each task requires only id and prompt')
        import re
        if not isinstance(task['id'], str) or not re.fullmatch(r'[a-z][a-z0-9-]*', task['id']):
            raise ValueError('Task id must be kebab-case')
        if not isinstance(task['prompt'], str) or not task['prompt'].strip():
            raise ValueError('Task prompt must be nonempty')
        stages.append({'title': f'Job {job}', 'agents': [task]})
    if not stages or len({s['agents'][0]['id'] for s in stages}) != len(stages):
        raise ValueError('Tasks must be nonempty with unique ids')
    return {'version': 1, 'planner': 'python-metaaco', 'execution': 'serial-order',
            'workflow': {'name': 'metaaco-plan', 'description': 'External MetaACO precedence-feasible order',
                         'stages': stages}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Directory containing rcpsp/core.py and rcpsp/metaACO.py')
    parser.add_argument('--instance', required=True, help='PSPLIB instance')
    parser.add_argument('--tasks', required=True, help='JSON mapping zero-based job indices to id/prompt')
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    sys.path.insert(0, args.source)
    try:
        from rcpsp.core import load_psplib_instance
        from rcpsp.metaACO import solve_rcpsp_psplib
    except ImportError as error:
        raise SystemExit(f'Real Python MetaACO unavailable; no fallback solver: {error}')
    with open(args.tasks, encoding='utf-8') as stream:
        tasks = json.load(stream)
    # The real solver writes diagnostics to stdout; reserve stdout for the contract.
    with contextlib.redirect_stdout(sys.stderr):
        schedule, _ = solve_rcpsp_psplib(args.instance, seed=args.seed, iterations=20,
                                       ants_per_iteration=5, max_evaluations=100)
    plan = make_plan(schedule, load_psplib_instance(args.instance), tasks)
    print(json.dumps(plan, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
