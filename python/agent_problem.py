"""Map agent tasks to the external MetaACO RCPSP model (one agent slot per task)."""
import random
import re

MAX_SAFE_INTEGER = 2**53 - 1


def positive_integer(value):
    return type(value) is int and 0 < value <= MAX_SAFE_INTEGER


def build_problem(problem):
    """Validate user data, then construct the real solver's model. Never call a model API."""
    if (not isinstance(problem, dict)
            or set(problem) != {'version', 'maxConcurrentAgents', 'tasks'}
            or type(problem['version']) is not int or problem['version'] != 1
            or not positive_integer(problem['maxConcurrentAgents'])
            or not isinstance(problem['tasks'], list) or not problem['tasks']):
        raise ValueError('Problem v1 requires maxConcurrentAgents and nonempty tasks')
    tasks = problem['tasks']
    index = {}
    for i, task in enumerate(tasks):
        if (not isinstance(task, dict)
                or set(task) != {'id', 'prompt', 'estimatedDurationSeconds', 'dependsOn'}
                or not isinstance(task['id'], str)
                or not re.fullmatch(r'[a-z][a-z0-9-]*', task['id'])
                or task['id'] in index
                or not isinstance(task['prompt'], str) or not task['prompt'].strip()
                or not positive_integer(task['estimatedDurationSeconds'])
                or not isinstance(task['dependsOn'], list)
                or any(not isinstance(dep, str) for dep in task['dependsOn'])
                or len(set(task['dependsOn'])) != len(task['dependsOn'])):
            raise ValueError('Each task requires a unique id, prompt, positive integer estimatedDurationSeconds and unique dependsOn ids')
        index[task['id']] = i
    durations = [task['estimatedDurationSeconds'] for task in tasks]
    if sum(durations) > MAX_SAFE_INTEGER:
        raise ValueError('Total estimated duration exceeds JSON safe integer range')
    predecessors = []
    for task in tasks:
        if any(dep not in index or dep == task['id'] for dep in task['dependsOn']):
            raise ValueError('Dependencies must reference other existing tasks')
        predecessors.append([index[dep] for dep in task['dependsOn']])
    successors = [[] for _ in tasks]
    for job, parents in enumerate(predecessors):
        for parent in parents:
            successors[parent].append(job)
    from rcpsp.core import RcpspInstance
    # The real model validates the DAG. No invented/dummy PSPLIB resource semantics.
    instance = RcpspInstance(len(tasks), 1, durations, [[1] for _ in tasks],
                             [problem['maxConcurrentAgents']], successors, predecessors)
    mapping = {str(i): {'id': task['id'], 'prompt': task['prompt']} for i, task in enumerate(tasks)}
    return instance, mapping


def plan_problem(problem, seed=42, execution='start-groups'):
    from rcpsp.metaACO import ColonyManager
    from metaaco_plan import make_plan
    instance, mapping = build_problem(problem)
    # The same real ColonyManager used by solve_rcpsp_psplib, with a bounded search.
    manager = ColonyManager(instance, random.Random(seed), max_evaluations=100)
    manager.init_random_colonies(3)
    schedule, _ = manager.run(iterations=20, ants_per_iteration=5, improvement_threshold=0.02)
    if schedule is None:
        raise RuntimeError('Real Python MetaACO returned no schedule')
    plan = make_plan(schedule, instance, mapping, execution)
    duration_by_id = {task['id']: task['estimatedDurationSeconds'] for task in problem['tasks']}
    barrier_duration = sum(max(duration_by_id[task['id']] for task in stage['agents'])
                           for stage in plan['workflow']['stages'])
    plan.update(version=2,
                resources={'agentSlots': problem['maxConcurrentAgents']},
                estimates={'objective': 'makespan', 'durationUnit': 'seconds',
                           'scheduleMakespan': schedule.makespan,
                           'executionMakespan': barrier_duration})
    plan['workflow']['name'] = 'metaaco-agent-plan'
    plan['workflow']['description'] = 'Agent tasks planned using estimated seconds and one agent slot per task'
    return plan
