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
