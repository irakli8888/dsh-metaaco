"""Versioned bridge from the real external MetaACO to DAG v3."""
import argparse
import contextlib
import copy
import hashlib
import importlib
import json
from pathlib import Path
import platform
import random
import re
import sys
import time

MAX_SAFE = 2**53 - 1
PARAMETERS = {'max_colonies': 10, 'max_evaluations': 100, 'replication_enabled': True,
              'elite_enabled': True, 'local_search_enabled': True, 'selection': 'ucb',
              'replication_mode': 'mutate'}


def integer(value, maximum=MAX_SAFE, minimum=1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('Expected bounded integer')


def fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('Unexpected contract fields')


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Expected nonempty text')


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', value):
        raise ValueError('Expected kebab-case identifier')


def validate_problem(problem):
    fields(problem, ['version', 'plan', 'durationEstimatesSeconds'])
    if type(problem['version']) is not int or problem['version'] != 2:
        raise ValueError('Expected problem v2')
    plan = problem['plan']
    fields(plan, ['version', 'execution', 'name', 'description', 'resources', 'tasks'])
    if type(plan['version']) is not int or plan['version'] != 3 or plan['execution'] != 'dag':
        raise ValueError('Expected DAG v3')
    identifier(plan['name']); text(plan['description'])
    resources = plan['resources']
    fields(resources, ['agentSlots', 'maxArtifactBytes', 'maxInputBytes', 'timeoutMs'])
    integer(resources['agentSlots'], 256)
    integer(resources['maxArtifactBytes'], 16 * 1024 * 1024)
    integer(resources['maxInputBytes'], 16 * 1024 * 1024)
    integer(resources['timeoutMs'], 2147483647)
    tasks = plan['tasks']
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 256:
        raise ValueError('Expected 1–256 tasks')
    ids = set()
    for task in tasks:
        fields(task, ['id', 'prompt', 'dependsOn', 'inputs', 'slots', 'model'])
        identifier(task['id']); text(task['prompt']); integer(task['slots'], resources['agentSlots'])
        if task['id'] in ids:
            raise ValueError('Duplicate task')
        ids.add(task['id'])
        deps = task['dependsOn']
        if not isinstance(deps, list) or any(not isinstance(d, str) for d in deps) or len(set(deps)) != len(deps):
            raise ValueError('Invalid dependencies')
        if not isinstance(task['inputs'], list):
            raise ValueError('Invalid inputs')
        names = set()
        for binding in task['inputs']:
            fields(binding, ['name', 'taskId']); identifier(binding['name']); identifier(binding['taskId'])
            if binding['name'] in names or binding['taskId'] not in deps:
                raise ValueError('Invalid artifact binding')
            names.add(binding['name'])
        if task['model'] is not None:
            fields(task['model'], ['provider', 'model'])
            text(task['model']['provider']); text(task['model']['model'])
    fields(problem['durationEstimatesSeconds'], ids)
    for duration in problem['durationEstimatesSeconds'].values():
        integer(duration)
    horizon = sum(problem['durationEstimatesSeconds'].values())
    if horizon > 86400:
        raise ValueError('Estimated duration horizon exceeds 86400 seconds for the time-indexed solver')
    for task in tasks:
        if any(d not in ids or d == task['id'] for d in task['dependsOn']):
            raise ValueError('Unknown/self dependency')
    return copy.deepcopy(problem)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def source_manifest(source):
    root = Path(source).resolve()
    manifest = {}
    for name, module in sorted(sys.modules.copy().items()):
        if name != 'rcpsp' and not name.startswith('rcpsp.'):
            continue
        path = getattr(module, '__file__', None)
        if path is None:
            continue
        path = Path(path).resolve()
        if not path.is_relative_to(root) or path.suffix != '.py':
            raise RuntimeError('Loaded solver does not match requested source; no fallback')
        manifest[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    if not {'rcpsp/core.py', 'rcpsp/metaACO.py'} <= manifest.keys():
        raise RuntimeError('Real solver source manifest incomplete; no fallback')
    return manifest


def plan_dag(problem, source, seed=42):
    p = validate_problem(problem)
    integer(seed, minimum=-MAX_SAFE)
    root = Path(source).resolve()
    if not all((root / path).is_file() for path in ['rcpsp/core.py', 'rcpsp/metaACO.py']):
        raise RuntimeError('Real MetaACO source unavailable; no fallback solver')
    sys.path.insert(0, str(root))
    try:
        core = importlib.import_module('rcpsp.core')
        solver = importlib.import_module('rcpsp.metaACO')
    finally:
        sys.path.pop(0)
    manifest = source_manifest(root)
    tasks = p['plan']['tasks']; index = {t['id']: i for i, t in enumerate(tasks)}
    predecessors = [[index[d] for d in t['dependsOn']] for t in tasks]
    successors = [[] for _ in tasks]
    for i, parents in enumerate(predecessors):
        for parent in parents:
            successors[parent].append(i)
    durations = [p['durationEstimatesSeconds'][t['id']] for t in tasks]
    instance = core.RcpspInstance(len(tasks), 1, durations, [[t['slots']] for t in tasks],
                                  [p['plan']['resources']['agentSlots']], successors, predecessors)
    started = time.perf_counter()
    manager = solver.ColonyManager(instance, random.Random(seed), **PARAMETERS)
    manager.init_random_colonies(3)
    schedule, _ = manager.run(iterations=20, ants_per_iteration=5, improvement_threshold=0.02)
    elapsed = (time.perf_counter() - started) * 1000
    if schedule is None or schedule.order is None:
        raise RuntimeError('Real MetaACO returned no ordered schedule')
    core.validate_schedule(instance, schedule)
    core.validate_order(instance, schedule.order)
    if source_manifest(root) != manifest:
        raise RuntimeError('Solver source changed during planning; discard this result')
    # Priority projection, NOT artificial precedence or exact future wall-clock timing.
    priority = sorted(schedule.order, key=lambda job: schedule.start_times[job])
    plan = copy.deepcopy(p['plan'])
    plan['tasks'] = [copy.deepcopy(tasks[j]) for j in priority]
    return {'schemaVersion': 1, 'planner': 'python-metaaco-dag', 'plan': plan,
            'estimates': {'durationUnit': 'seconds', 'scheduleMakespan': schedule.makespan,
                          'executionMakespan': None, 'reason': 'DAG uses priorities and actual completions, not scheduled start times',
                          'order': [tasks[j]['id'] for j in schedule.order],
                          'schedule': [{'taskId': t['id'], 'startSeconds': schedule.start_times[j],
                                        'durationSeconds': durations[j]} for j, t in enumerate(tasks)]},
            'measured': {'solverWallTimeMs': elapsed, 'evaluations': manager.budget.used},
            'provenance': {'seed': seed, 'parameters': {**PARAMETERS, 'init_colonies': 3, 'iterations': 20,
                                                      'ants_per_iteration': 5, 'improvement_threshold': 0.02},
                           'sourceFiles': manifest, 'bridgeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                           'pythonVersion': platform.python_version(), 'problemSha256': digest(p)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default=Path(__file__).resolve().parent / 'vendor')
    parser.add_argument('--problem', required=True)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    with open(args.problem, encoding='utf-8') as stream:
        problem = json.load(stream)
    with contextlib.redirect_stdout(sys.stderr):
        result = plan_dag(problem, args.source, args.seed)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
