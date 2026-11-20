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


def search_decisions(groups, evaluate, *, seed=42, max_evaluations=100, initial_choices=None):
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
    if initial_choices is not None:
        if set(initial_choices) != set(groups) or any(initial_choices[key] not in values for key, values in groups.items()):
            raise ValueError('Initial choices must select one valid alternative per group')
        first = list(initial_choices.values())
        order = [alternatives.index(value) for value in first + [value for value in alternatives if value not in first]]
        colony = manager.bandit.colonies[0]
        manager.budget.start()
        manager.budget.counts['initialization'] = 0
        candidate = colony.sgs.generate(carrier, order, category='initialization')
        if candidate.makespan != penalty:
            colony.best_schedule, colony.best_order, colony.best_cost = candidate, list(order), candidate.makespan
            manager.elite.add(candidate)
            colony.pheromones.deposit_on_order(order, amount=0.3 * colony.tau0)
    best, _ = manager.run(iterations=max_evaluations, ants_per_iteration=5)
    if best is None or best.makespan == penalty:
        raise ValueError('No feasible choice found within the evaluation budget')
    return {'choices': decode_order(groups, [alternatives[index] for index in best.order]),
            'score': best.makespan, 'evaluations': manager.budget.used}


def search_workflow(groups, build_candidate, budget_microunits, *, quality_evidence=(),
                    explore_training=False, training_evidence=(), **search_options):
    """Score decoded DAGs by forecast makespan after a hard cost gate."""
    from metaaco_dag import integer, validate_problem
    from vendor.rcpsp.core import (RcpspInstance, SerialScheduleGenerator,
                                 topological_order, validate_schedule)

    integer(budget_microunits, minimum=0)
    import json

    def route_key(route):
        return json.dumps(route, ensure_ascii=False)

    evidence = {}
    for row in quality_evidence:
        integer(row['attempts'])
        integer(row['successes'], maximum=row['attempts'], minimum=0)
        evidence[route_key(row['route'])] = row
    evaluated = {}
    routes = {}
    route_attempts = {}
    for row in training_evidence:
        integer(row['attempts'])
        route_attempts[route_key(row['route'])] = row['attempts']
    observations = {}
    trace = []
    trace_limit = 100

    def measure(choices):
        key = tuple(choices.items())
        if key in evaluated:
            return evaluated[key]
        candidate = build_candidate(choices)
        if candidate is None:
            evaluated[key] = {'rejected': 'missing-component-design', 'makespanSeconds': None,
                              'dispatchOrder': None, 'estimatedCostMicrounits': None}
            return evaluated[key]
        problem, cost = candidate
        integer(cost, minimum=0)
        if cost > budget_microunits:
            evaluated[key] = {'estimatedCostMicrounits': cost, 'rejected': 'over-budget',
                              'makespanSeconds': None, 'dispatchOrder': None}
            return evaluated[key]
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
        priority = {skill: position for position, skill in enumerate(choices)}
        order = topological_order(instance, [priority.get(name, len(priority)) for name in ids])
        schedule = SerialScheduleGenerator().generate(instance, order)
        validate_schedule(instance, schedule)
        route = [[task['id'], (task['model'] or {}).get('provider'), (task['model'] or {}).get('model'),
                  sorted(task['dependsOn'])] for task in sorted(tasks, key=lambda task: task['id'])]
        data = evidence.get(route_key(route))
        quality = None
        rank = 500
        if data:
            rank = (data['successes'] + 1) * 1000 // (data['attempts'] + 2)
            quality = {'successes': data['successes'], 'attempts': data['attempts'],
                       'estimatedSuccess': rank / 1000}
        evaluated[key] = {'problem': problem, 'quality': quality,
                          'objective': (1000 - rank) * 86401 + schedule.makespan, 'estimatedCostMicrounits': cost,
                          'makespanSeconds': schedule.makespan, 'rejected': None,
                          'dispatchOrder': [ids[job] for job in sorted(order, key=lambda j: schedule.start_times[j])]}
        if explore_training:
            identity = route_key(route)
            observations[key] = route_attempts.get(identity, 0) + (data or {}).get('attempts', 0)
            previous = routes.get(identity)
            if previous is None or (evaluated[key]['objective'], key) < (evaluated[previous]['objective'], previous):
                routes[identity] = key
        return evaluated[key]

    def evaluate(choices):
        row = measure(choices)
        if len(trace) < trace_limit:
            trace.append({'evaluation': len(trace) + 1, 'choices': dict(choices),
                          'priority': list(choices), **{key: value for key, value in row.items()
                                                       if key != 'problem'}})
        return row.get('objective')

    result = search_decisions(groups, evaluate, **search_options)
    winner = tuple(result['choices'].items())
    selected = evaluated[winner]
    if explore_training:
        def observed(key):
            return observations[key]

        best_route = min(routes.values(), key=lambda key: (observed(key), evaluated[key]['objective'], key))
        # Retain the optimizer's exact schedule when it ties the exploration policy.
        chosen = winner if (observed(winner), selected['objective']) == (
            observed(best_route), evaluated[best_route]['objective']) else best_route
        selected = evaluated[chosen]
        result = {**result, 'choices': dict(chosen), 'score': selected['objective'],
                  'exploration': {'schemaVersion': 1, 'policy': 'least-observed-route',
                                  'distinctFeasibleRoutes': len(routes),
                                  'selectedObservedAttempts': observed(chosen),
                                  'optimizerWinner': {'choices': dict(winner), 'score': result['score'],
                                                      'observedAttempts': observed(winner)}}}
    return {**result, **selected, 'trace': {'schemaVersion': 1, 'evaluations': trace,
                                          'omitted': result['evaluations'] - len(trace)}}


def plan_skill_graph(catalog, resources, budget_microunits, *, required_skills=(),
                    component_design_required=False, ensure_feasible_start=False, **options):
    """Build workflow DAGs lazily from skill routes and optional branches."""
    required = {'implement', 'refactor'}
    optional = {'analyze', 'design', 'write-tests', 'review'}
    import re
    components = sorted(skill for skill in catalog if re.fullmatch(r'implement-[a-z0-9-]{1,53}', skill))
    if components and (len(components) < 2 or 'integrate' not in catalog):
        raise ValueError('Component layout requires integration and at least two components')
    if component_design_required and components and 'design' not in catalog:
        raise ValueError('Component design requires a design skill')
    supported = required | optional | set(components) | {'integrate'}
    mandatory = set(required_skills)
    if not mandatory <= (optional & catalog.keys()):
        raise ValueError('Required optional skills must exist in the catalog')
    if not required <= catalog.keys() or not catalog.keys() <= supported:
        raise ValueError('Invalid skill catalog')
    if ('write-tests' in catalog or bool(components)) != ('integrate' in catalog):
        raise ValueError('Test preparation requires integration')
    groups = {'layout': ['monolith', 'components']} if components else {}
    for skill, routes in catalog.items():
        if not isinstance(routes, list) or not routes:
            raise ValueError('Each skill needs at least one route')
        groups[skill] = [f'{skill}/{i}' for i in range(len(routes))]
        if skill in optional and skill not in mandatory:
            groups[skill].append(f'{skill}/skip')

    def build(choices):
        if component_design_required and choices.get('layout') == 'components' and choices.get('design', 'design/skip') == 'design/skip':
            return None
        dependencies = {}
        if choices.get('analyze', 'analyze/skip') != 'analyze/skip':
            dependencies['analyze'] = []
        context = ['analyze'] if 'analyze' in dependencies else []
        if choices.get('design', 'design/skip') != 'design/skip':
            dependencies['design'] = context
            context = ['design']
        implementations = components if choices.get('layout') == 'components' else ['implement']
        for skill in implementations:
            dependencies[skill] = context
        integration_inputs = list(implementations)
        if choices.get('write-tests', 'write-tests/skip') != 'write-tests/skip':
            dependencies['write-tests'] = context
            integration_inputs.append('write-tests')
        if component_design_required and choices.get('layout') == 'components':
            integration_inputs.append('design')
        if len(integration_inputs) > 1:
            dependencies['integrate'] = integration_inputs
        implementation = 'integrate' if 'integrate' in dependencies else 'implement'
        dependencies['refactor'] = [implementation]
        if choices.get('review', 'review/skip') != 'review/skip':
            dependencies['review'] = [implementation]
            dependencies['refactor'].append('review')
        tasks, durations, cost = [], {}, 0
        for skill, parents in dependencies.items():
            route = catalog[skill][int(choices[skill].rsplit('/', 1)[1])]
            from metaaco_dag import integer
            integer(route['costMicrounits'], minimum=0)
            cost += route['costMicrounits']
            durations[skill] = route['seconds']
            tasks.append({'id': skill, 'dependsOn': parents, 'prompt': route['prompt'],
                          'slots': 1, 'model': route['model'],
                          'inputs': [{'name': parent, 'taskId': parent} for parent in parents]})
        plan = {'version': 3, 'execution': 'dag', 'name': 'skill-search',
                'description': 'Workflow assembled by MetaACO', 'resources': resources, 'tasks': tasks}
        return {'version': 2, 'plan': plan, 'durationEstimatesSeconds': durations}, cost

    initialization = None
    if ensure_feasible_start:
        # Structural lower-cost starts, not learned winners or a replacement solver.
        starts = []
        for layout in (['monolith', 'components'] if components else ['monolith']):
            choices = {}
            if components:
                choices['layout'] = layout
            for skill, routes in catalog.items():
                if skill in optional and skill not in mandatory and not (layout == 'components' and component_design_required and skill == 'design'):
                    choices[skill] = f'{skill}/skip'
                else:
                    index = min(range(len(routes)), key=lambda i: routes[i]['costMicrounits'])
                    choices[skill] = f'{skill}/{index}'
            candidate = build(choices)
            if candidate is not None:
                starts.append((candidate[1], choices))
        cost, choices = min(starts, key=lambda row: row[0])
        options['initial_choices'] = choices
        initialization = {'policy': 'minimum-cost-minimal-layout', 'choices': choices,
                          'structuralStartsConsidered': len(starts), 'objectiveEvaluation': 1,
                          'estimatedCostMicrounits': cost, 'costIsForecast': True}
    result = search_workflow(groups, build, budget_microunits, **options)
    return {**result, **({'initialization': initialization} if initialization is not None else {})}


if __name__ == '__main__':
    import argparse
    import json
    from pathlib import Path

    parser = argparse.ArgumentParser(description='Plan a workflow from a skill catalog')
    parser.add_argument('catalog', type=Path)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    spec = json.loads(args.catalog.read_text(encoding='utf-8'))
    print(json.dumps(plan_skill_graph(spec['skills'], spec['resources'],
                                     spec['budgetMicrounits'], required_skills=spec.get('requiredSkills', []),
                                     quality_evidence=spec.get('qualityEvidence', []),
                                     component_design_required=spec.get('componentDesignRequired') is True,
                                     ensure_feasible_start=spec.get('ensureFeasibleStart') is True,
                                     training_evidence=spec.get('trainingEvidence', []),
                                     explore_training=spec.get('exploreTraining') is True, seed=args.seed)))
