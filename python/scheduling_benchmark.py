"""Compare real MetaACO with a fixed order and an exact oracle on a small DAG."""
import itertools
import json
from pathlib import Path

from metaaco_dag import plan_dag
from vendor.rcpsp.core import RcpspInstance, SerialScheduleGenerator, validate_schedule

SOURCE = Path(__file__).resolve().parent / 'vendor'


def run_benchmark(seeds=(7, 11, 42)):
    ids = ['review', 'docs', 'patch', 'tests']
    durations = [4, 4, 1, 10]
    dependencies = [[], [], [], [2]]
    instance = RcpspInstance(4, 1, durations, [[1]] * 4, [2],
                             [[], [], [3], []], dependencies)
    tasks = [
        {'id': name, 'prompt': f'Perform {name}', 'dependsOn': [ids[i] for i in parents],
         'inputs': [], 'slots': 1, 'model': None}
        for name, parents in zip(ids, dependencies)
    ]
    problem = {'version': 2, 'plan': {
        'version': 3, 'execution': 'dag', 'name': 'scheduling-benchmark',
        'description': 'Two independent jobs compete with a critical path',
        'resources': {'agentSlots': 2, 'maxArtifactBytes': 1024, 'maxInputBytes': 4096, 'timeoutMs': 60000},
        'tasks': tasks}, 'durationEstimatesSeconds': dict(zip(ids, durations))}
    generator = SerialScheduleGenerator()

    def makespan(order):
        schedule = generator.generate(instance, list(order))
        validate_schedule(instance, schedule)
        return schedule.makespan

    rows = []
    for seed in seeds:
        result = plan_dag(problem, SOURCE, seed)
        rows.append({'seed': seed, 'estimatedMakespanSeconds': result['estimates']['scheduleMakespan'],
                     'order': result['estimates']['order'], **result['measured']})
    feasible_orders = [order for order in itertools.permutations(range(4)) if order.index(2) < order.index(3)]
    return {'fixedOrder': ids, 'fixedEstimatedMakespanSeconds': makespan(range(4)),
            'exactEstimatedMakespanSeconds': min(map(makespan, feasible_orders)), 'metaaco': rows}


if __name__ == '__main__':
    print(json.dumps(run_benchmark(), indent=2))
