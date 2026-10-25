"""Bridge to the external RCPSP MetaACO implementation; no replacement solver."""
import argparse
import contextlib
import json
import re
import sys


def make_plan(schedule, instance, tasks, execution="start-groups"):
    if execution not in {"serial-order", "start-groups"}:
        raise ValueError("Unknown execution mode")
    from rcpsp.core import validate_schedule, validate_order
    validate_schedule(instance, schedule)
    if schedule.order is None:
        raise ValueError('MetaACO must return an explicit precedence-feasible order')
    validate_order(instance, schedule.order)
    expected = {str(j) for j, duration in enumerate(instance.durations) if duration > 0}
    if not isinstance(tasks, dict) or set(tasks) != expected:
        raise ValueError('tasks must map every positive-duration zero-based job index exactly once')
    stages = []
    groups = {}
    ids = set()
    for job in schedule.order:
        if str(job) not in tasks:
            continue
        task = tasks[str(job)]
        if not isinstance(task, dict) or set(task) != {'id', 'prompt'}:
            raise ValueError('Each task requires only id and prompt')
        if not isinstance(task['id'], str) or not re.fullmatch(r'[a-z][a-z0-9-]*', task['id']):
            raise ValueError('Task id must be kebab-case')
        if not isinstance(task['prompt'], str) or not task['prompt'].strip():
            raise ValueError('Task prompt must be nonempty')
        if task['id'] in ids:
            raise ValueError('Tasks must be nonempty with unique ids')
        ids.add(task['id'])
        stages.append({'title': f'Job {job}', 'agents': [task]})
        groups.setdefault(schedule.start_times[job], []).append(task)
    if not stages:
        raise ValueError('Tasks must be nonempty with unique ids')
    if execution == 'start-groups':
        stages = [{'title': f'Start {start}', 'agents': groups[start]} for start in sorted(groups)]
    return {'version': 1, 'planner': 'python-metaaco', 'execution': execution,
            'workflow': {'name': 'metaaco-plan', 'description': 'External MetaACO validated schedule projection',
                         'stages': stages}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Directory containing rcpsp/core.py and rcpsp/metaACO.py')
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--instance', help='PSPLIB instance; requires --tasks')
    inputs.add_argument('--problem', help='Agent problem JSON with slot capacity and estimated durations')
    parser.add_argument('--tasks', help='JSON mapping zero-based PSPLIB job indices to id/prompt')
    parser.add_argument('--execution', choices=['serial-order', 'start-groups'], default='start-groups')
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    if args.instance and not args.tasks:
        parser.error('--instance requires --tasks')
    if args.problem and args.tasks:
        parser.error('--tasks is only supported with --instance')
    sys.path.insert(0, args.source)
    try:
        from rcpsp.core import load_psplib_instance
        from rcpsp.metaACO import solve_rcpsp_psplib
    except ImportError as error:
        raise SystemExit(f'Real Python MetaACO unavailable; no fallback solver: {error}')
    if args.problem:
        from agent_problem import plan_problem
        with open(args.problem, encoding='utf-8') as stream:
            problem = json.load(stream)
        with contextlib.redirect_stdout(sys.stderr):
            plan = plan_problem(problem, args.seed, args.execution)
        print(json.dumps(plan, ensure_ascii=False, allow_nan=False))
        return
    with open(args.tasks, encoding='utf-8') as stream:
        tasks = json.load(stream)
    # The real solver writes diagnostics to stdout; reserve stdout for the contract.
    with contextlib.redirect_stdout(sys.stderr):
        schedule, _ = solve_rcpsp_psplib(args.instance, seed=args.seed, iterations=20,
                                       ants_per_iteration=5, max_evaluations=100)
    plan = make_plan(schedule, load_psplib_instance(args.instance), tasks, args.execution)
    print(json.dumps(plan, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
