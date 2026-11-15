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
