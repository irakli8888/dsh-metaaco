"""Decode an ant's priority order into one choice per decision group."""


def decode_order(groups, order):
    """Use the first encountered alternative in each group.

    Alternatives have globally unique IDs. The order must contain all alternatives,
    allowing the existing permutation-based search to represent every assignment.
    Feasibility and scoring of the resulting workflow belong to the graph decoder.
    """
    owners = {}
    for decision, alternatives in groups.items():
        if not alternatives:
            raise ValueError('Each decision needs at least one alternative')
        for alternative in alternatives:
            if alternative in owners:
                raise ValueError('Duplicate decision alternative')
            owners[alternative] = decision
    if len(order) != len(owners) or set(order) != set(owners):
        raise ValueError('Expected a permutation of decision alternatives')
    choices = {}
    for alternative in order:
        choices.setdefault(owners[alternative], alternative)
    return choices


def search_decisions(groups, evaluate, *, seed=42, max_evaluations=100):
    """Run the bundled colonies with a decoded-graph scoring callback.

    Scores are positive integers below the infeasibility penalty. Return None
    from evaluate to reject a candidate without terminating a colony.
    """
    import random

    from vendor.rcpsp.core import RcpspInstance
    from vendor.rcpsp.metaACO import ColonyManager

    alternatives = [item for options in groups.values() for item in options]
    decode_order(groups, alternatives)
    size = len(alternatives)
    if not 1 <= size <= 64:
        raise ValueError('Expected 1–64 decision alternatives')
    carrier = RcpspInstance(size, 1, [1] * size, [[1]] * size, [1],
                            [[] for _ in alternatives], [[] for _ in alternatives])
    penalty = 2**53 - 1

    def score(order):
        choices = decode_order(groups, [alternatives[index] for index in order])
        value = evaluate(choices)
        if value is None:
            return penalty
        if type(value) is not int or not 0 < value < penalty:
            raise ValueError('Expected a positive bounded integer score')
        return value

    manager = ColonyManager(carrier, random.Random(seed), max_evaluations=max_evaluations,
                            order_evaluator=score)
    manager.init_random_colonies(3)
    best, _ = manager.run(iterations=max_evaluations, ants_per_iteration=5)
    if best is None or best.makespan == penalty:
        raise ValueError('No feasible choice found within the evaluation budget')
    return {'choices': decode_order(groups, [alternatives[index] for index in best.order]),
            'score': best.makespan, 'evaluations': manager.budget.used}


def search_workflow(groups, build_candidate, budget_microunits, **search_options):
    """Score decoded DAGs by forecast makespan after a hard cost gate."""
    from metaaco_dag import integer, validate_problem
    from vendor.rcpsp.core import (RcpspInstance, SerialScheduleGenerator,
                                 topological_order, validate_schedule)

    integer(budget_microunits, minimum=0)
    evaluated = {}

    def evaluate(choices):
        key = tuple(sorted(choices.items()))
        if key in evaluated:
            return evaluated[key]['makespanSeconds'] if evaluated[key] else None
        problem, cost = build_candidate(choices)
        integer(cost, minimum=0)
        if cost > budget_microunits:
            evaluated[key] = None
            return None
        problem = validate_problem(problem)
        tasks = problem['plan']['tasks']
        ids = [task['id'] for task in tasks]
        index = {name: i for i, name in enumerate(ids)}
        predecessors = [[index[parent] for parent in task['dependsOn']] for task in tasks]
        successors = [[] for _ in tasks]
        for job, parents in enumerate(predecessors):
            for parent in parents:
                successors[parent].append(job)
        durations = [problem['durationEstimatesSeconds'][name] for name in ids]
        instance = RcpspInstance(len(ids), 1, durations, [[task['slots']] for task in tasks],
                                 [problem['plan']['resources']['agentSlots']], successors, predecessors)
        order = topological_order(instance)
        schedule = SerialScheduleGenerator().generate(instance, order)
        validate_schedule(instance, schedule)
        evaluated[key] = {'problem': problem, 'estimatedCostMicrounits': cost,
                          'makespanSeconds': schedule.makespan}
        return schedule.makespan

    result = search_decisions(groups, evaluate, **search_options)
    return {**result, **evaluated[tuple(sorted(result['choices'].items()))]}
