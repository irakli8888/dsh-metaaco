import unittest

from skill_decisions import decode_order


class SkillDecisionTests(unittest.TestCase):
    def test_order_selects_optional_skill_and_model(self):
        groups = {'design': ['skip-design', 'use-design'],
                  'implement': ['cheap-model', 'strong-model']}
        self.assertEqual(decode_order(groups, ['skip-design', 'strong-model', 'use-design', 'cheap-model']),
                         {'design': 'skip-design', 'implement': 'strong-model'})
        self.assertEqual(decode_order(groups, ['use-design', 'cheap-model', 'skip-design', 'strong-model']),
                         {'design': 'use-design', 'implement': 'cheap-model'})

    def test_incomplete_order_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'permutation'):
            decode_order({'design': ['skip', 'use']}, ['skip'])

    def test_metaaco_search_scores_decoded_choices(self):
        from skill_decisions import search_decisions
        groups = {'design': ['skip', 'use'], 'model': ['cheap', 'strong']}
        costs = {('skip', 'cheap'): 12, ('use', 'cheap'): 9, ('use', 'strong'): 5}
        result = search_decisions(groups, lambda choices: costs.get((choices['design'], choices['model'])))
        self.assertEqual(result['choices'], {'design': 'use', 'model': 'strong'})
        self.assertEqual(result['score'], min(costs.values()))
        self.assertLessEqual(result['evaluations'], 100)

    def test_workflow_search_respects_model_budget(self):
        from skill_decisions import search_workflow
        from test_metaaco_dag import problem

        def build(choices):
            candidate = problem()
            model = choices['model']
            candidate['plan']['tasks'][0]['model'] = {'provider': 'offline', 'model': model}
            candidate['durationEstimatesSeconds']['slow'] = 10 if model == 'strong' else 30
            return candidate, 20 if model == 'strong' else 5

        for budget, model in [(5, 'cheap'), (20, 'strong')]:
            result = search_workflow({'model': ['cheap', 'strong']}, build, budget)
            self.assertEqual(result['choices']['model'], model)
            self.assertLessEqual(result['estimatedCostMicrounits'], budget)

    def test_catalog_builds_dag_with_required_green_and_refactor(self):
        from skill_decisions import plan_skill_graph
        from test_metaaco_dag import problem

        def route(name, seconds, cost):
            return {'model': {'provider': 'offline', 'model': name},
                    'seconds': seconds, 'costMicrounits': cost, 'prompt': f'Use {name}'}

        catalog = {'implement': [route('cheap', 9, 3), route('fast', 2, 8)],
                   'design': [route('cheap', 2, 3)], 'refactor': [route('cheap', 2, 3)]}
        resources = problem()['plan']['resources']
        result = plan_skill_graph(catalog, resources, 11)
        tasks = result['problem']['plan']['tasks']
        self.assertEqual([task['id'] for task in tasks], ['implement', 'refactor'])
        self.assertEqual(tasks[0]['model']['model'], 'fast')
        self.assertEqual(tasks[1]['inputs'], [{'name': 'implement', 'taskId': 'implement'}])
        self.assertEqual(result['makespanSeconds'], 4)

    def test_ant_priority_matches_exhaustive_schedule_oracle(self):
        from itertools import permutations
        from skill_decisions import search_workflow
        from test_metaaco_dag import problem
        from vendor.rcpsp.core import RcpspInstance, SerialScheduleGenerator

        candidate = problem()
        plan = candidate['plan']
        plan['tasks'].insert(1, {'id': 'docs', 'prompt': 'docs', 'slots': 1,
                                 'dependsOn': [], 'inputs': [], 'model': None})
        candidate['durationEstimatesSeconds'] = {'slow': 4, 'docs': 4, 'fast': 1, 'child': 10}
        instance = RcpspInstance(4, 1, [4, 4, 1, 10], [[1]] * 4, [2],
                                 [[], [], [3], []], [[], [], [], [2]])
        generator = SerialScheduleGenerator()
        exact = min(generator.generate(instance, order).makespan
                    for order in permutations(range(4)) if order.index(2) < order.index(3))
        groups = {task['id']: [task['id']] for task in plan['tasks']}
        result = search_workflow(groups, lambda _: (candidate, 5), 5)
        self.assertEqual(exact, 11)
        self.assertEqual(result['makespanSeconds'], exact)
        self.assertIn('fast', result['dispatchOrder'][:2])

    def test_workflow_trace_records_gate_and_priorities(self):
        from skill_decisions import search_workflow
        from test_metaaco_dag import problem

        result = search_workflow({'slow': ['cheap', 'expensive'], 'fast': ['run-fast']},
                                 lambda choices: (problem(), 5 if choices['slow'] == 'cheap' else 20), 5)
        trace = result['trace']
        self.assertEqual(trace['schemaVersion'], 1)
        self.assertEqual(len(trace['evaluations']), result['evaluations'])
        self.assertTrue(any(row['rejected'] == 'over-budget' for row in trace['evaluations']))
        self.assertTrue(any(row['dispatchOrder'] == result['dispatchOrder']
                            and row['makespanSeconds'] == result['makespanSeconds']
                            for row in trace['evaluations']))

    def test_review_and_analysis_with_budgeted_model_choices(self):
        from skill_decisions import plan_skill_graph
        from test_metaaco_dag import problem

        def route(model, seconds, cost):
            return {'model': {'provider': 'offline', 'model': model}, 'prompt': 'Work',
                    'seconds': seconds, 'costMicrounits': cost}

        catalog = {skill: [route('small', 4, 2), route('large', 1, 8)]
                   for skill in ['analyze', 'implement', 'review', 'refactor']}
        for budget, expected in [(8, 'small'), (32, 'large')]:
            result = plan_skill_graph(catalog, problem()['plan']['resources'], budget,
                                      required_skills=['analyze', 'review'])
            tasks = {task['id']: task for task in result['problem']['plan']['tasks']}
            self.assertEqual(set(tasks), set(catalog))
            self.assertEqual(tasks['implement']['dependsOn'], ['analyze'])
            self.assertEqual(tasks['review']['dependsOn'], ['implement'])
            self.assertEqual(tasks['refactor']['dependsOn'], ['implement', 'review'])
            self.assertEqual(tasks['review']['model']['model'], expected)
            self.assertLessEqual(result['estimatedCostMicrounits'], budget)

    def test_component_implementations_compete_with_monolith(self):
        from skill_decisions import plan_skill_graph
        from test_metaaco_dag import problem

        def route(seconds, cost):
            return {'model': {'provider': 'offline', 'model': 'm'}, 'prompt': 'Work',
                    'seconds': seconds, 'costMicrounits': cost}

        catalog = {'implement': [route(12, 2)], 'refactor': [route(1, 1)], 'integrate': [route(1, 1)],
                   'implement-storage': [route(3, 3)], 'implement-http': [route(3, 3)]}
        for budget, expected in [(3, 'monolith'), (8, 'components')]:
            result = plan_skill_graph(catalog, problem()['plan']['resources'], budget)
            self.assertEqual(result['choices']['layout'], expected)
            tasks = {task['id']: task for task in result['problem']['plan']['tasks']}
            if expected == 'components':
                self.assertEqual(set(tasks['integrate']['dependsOn']), {'implement-storage', 'implement-http'})
                self.assertEqual(result['makespanSeconds'], 5)

    def test_verified_quality_can_win_over_shorter_duration(self):
        from skill_decisions import plan_skill_graph
        from test_metaaco_dag import problem

        def route(model, seconds):
            return {'model': {'provider': 'offline', 'model': model}, 'prompt': 'Work',
                    'seconds': seconds, 'costMicrounits': 1}

        catalog = {'implement': [route('fast', 1), route('proven', 8)], 'refactor': [route('fast', 1)]}
        evidence = [{'route': [['implement', 'offline', 'proven', []],
                               ['refactor', 'offline', 'fast', ['implement']]],
                     'successes': 3, 'attempts': 3}]
        result = plan_skill_graph(catalog, problem()['plan']['resources'], 2, quality_evidence=evidence)
        self.assertEqual(result['choices']['implement'], 'implement/1')
        self.assertEqual(result['quality']['attempts'], 3)
        self.assertEqual(result['makespanSeconds'], 9)

    def test_training_explores_unobserved_feasible_route(self):
        from skill_decisions import plan_skill_graph
        from test_metaaco_dag import problem

        def route(model, seconds, cost=1):
            return {'model': {'provider': 'offline', 'model': model}, 'prompt': 'Work',
                    'seconds': seconds, 'costMicrounits': cost}

        catalog = {'implement': [route('known', 1), route('new', 3), route('over', 1, 9)],
                   'refactor': [route('known', 1)]}
        evidence = [{'route': [['implement', 'offline', 'known', []],
                               ['refactor', 'offline', 'known', ['implement']]],
                     'successes': 3, 'attempts': 3}]
        resources = problem()['plan']['resources']
        baseline = plan_skill_graph(catalog, resources, 2, quality_evidence=evidence)
        result = plan_skill_graph(catalog, resources, 2, quality_evidence=evidence, explore_training=True)
        self.assertEqual(baseline['choices']['implement'], 'implement/0')
        self.assertEqual(result['choices']['implement'], 'implement/1')
        self.assertEqual(result['score'], result['objective'])
        self.assertEqual(result['trace'], baseline['trace'])
        self.assertEqual(result['exploration']['distinctFeasibleRoutes'], 2)
        self.assertEqual(result['exploration']['selectedObservedAttempts'], 0)
        self.assertEqual(result['exploration']['optimizerWinner']['choices'], baseline['choices'])

    def test_component_layout_requires_model_generated_design_when_enabled(self):
        from skill_decisions import plan_skill_graph
        from test_metaaco_dag import problem
        route = lambda seconds: {'model': {'provider': 'offline', 'model': 'm'}, 'prompt': 'Work',
                                 'seconds': seconds, 'costMicrounits': 1}
        catalog = {'implement': [route(50)], 'design': [route(1)], 'integrate': [route(1)],
                   'implement-a': [route(1)], 'implement-b': [route(1)], 'refactor': [route(1)]}
        result = plan_skill_graph(catalog, problem()['plan']['resources'], 100, component_design_required=True)
        self.assertEqual(result['choices']['layout'], 'components')
        self.assertEqual(result['choices']['design'], 'design/0')
        tasks = {task['id']: task for task in result['problem']['plan']['tasks']}
        self.assertEqual(tasks['implement-a']['dependsOn'], ['design'])
        self.assertIn('design', tasks['integrate']['dependsOn'])
        self.assertTrue(any(row.get('rejected') == 'missing-component-design' for row in result['trace']['evaluations']))


class FeasibleInitializationTests(unittest.TestCase):
    def test_sparse_feasible_catalog_seed_is_evaluated_inside_metaaco_budget(self):
        from skill_decisions import plan_skill_graph
        from test_metaaco_dag import problem
        route = lambda cost: {'model': {'provider':'offline','model':str(cost)}, 'seconds':10, 'costMicrounits':cost, 'prompt':'Implement'}
        catalog = {skill:[route(309831),route(1352441)] for skill in
                   ['implement','refactor','design','integrate','analyze','review','write-tests','implement-a','implement-b','implement-c']}
        result=plan_skill_graph(catalog,problem()['plan']['resources'],987446,
                               seed=7,component_design_required=True,ensure_feasible_start=True)
        self.assertLessEqual(result['evaluations'],100)
        self.assertEqual(result['initialization']['policy'],'minimum-cost-minimal-layout')
        self.assertEqual(result['trace']['evaluations'][0]['estimatedCostMicrounits'],619662)
        self.assertIsNone(result['trace']['evaluations'][0]['rejected'])
        self.assertGreater(result['evaluations'],1)


    def test_initialization_does_not_replace_colony_search_or_exceed_budget(self):
        from skill_decisions import search_decisions
        result=search_decisions({'model':['cheap','better']},lambda c: 10 if c['model']=='cheap' else 1,
                                initial_choices={'model':'cheap'},seed=7,max_evaluations=20)
        self.assertEqual(result['score'],1)
        self.assertGreater(result['evaluations'],1)
        limited=search_decisions({'model':['cheap','better']},lambda c: 10,
                                 initial_choices={'model':'cheap'},max_evaluations=1)
        self.assertEqual(limited['evaluations'],1)
        with self.assertRaisesRegex(ValueError,'No feasible'):
            search_decisions({'model':['cheap']},lambda c:None,initial_choices={'model':'cheap'},max_evaluations=2)
