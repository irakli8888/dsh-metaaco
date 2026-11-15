import copy
from pathlib import Path
import unittest

from test_metaaco_dag import problem, SOURCE
from metaaco_variants import choose_variant


class VariantTests(unittest.TestCase):
    def test_budget_changes_graph_and_model(self):
        fast = problem()
        fast['plan']['tasks'][0]['model'] = {'provider': 'offline', 'model': 'strong'}
        cheap = copy.deepcopy(fast)
        cheap['plan']['tasks'].pop(0)
        cheap['plan']['tasks'][0]['model'] = {'provider': 'offline', 'model': 'cheap'}
        cheap['durationEstimatesSeconds'] = {'fast': 30, 'child': 30}
        variants = [
            {'id': 'parallel', 'problem': fast, 'costMicrounits': 20},
            {'id': 'simple', 'problem': cheap, 'costMicrounits': 5},
        ]
        source = SOURCE or Path(__file__).parent / 'vendor'
        for budget, expected, makespan in [(5, 'simple', 60), (20, 'parallel', 30)]:
            result = choose_variant(variants, ['child'], budget, source)
            self.assertEqual(result['selectedId'], expected)
            self.assertEqual(result['schedule']['estimates']['scheduleMakespan'], makespan)
        with self.assertRaisesRegex(ValueError, 'No feasible'):
            choose_variant(variants, ['child'], 4, source)
