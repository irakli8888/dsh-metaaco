"""Opt-in integration tests against the real external solver, never a substitute."""
import os
import random
import sys
import unittest

source = os.environ.get('METAACO_SOURCE')
if source:
    sys.path.insert(0, source)
from metaaco_plan import make_plan


@unittest.skipUnless(source, 'Set METAACO_SOURCE to the real repository containing rcpsp')
class RealSolverTests(unittest.TestCase):
    def setUp(self):
        from rcpsp.core import RcpspInstance
        from rcpsp.metaACO import ColonyManager
        self.instance = RcpspInstance(4, 1, [0, 2, 1, 0], [[0], [1], [1], [0]],
                                      [1], [[1], [2], [3], []], [[], [0], [1], [2]])
        manager = ColonyManager(self.instance, random.Random(42), max_colonies=2,
                                max_evaluations=30)
        manager.init_random_colonies(1)
        self.schedule, _ = manager.run(iterations=3, ants_per_iteration=2)
        self.tasks = {'1': {'id': 'first', 'prompt': 'first'},
                      '2': {'id': 'second', 'prompt': 'second'}}

    def test_real_schedule_becomes_serial_contract(self):
        plan = make_plan(self.schedule, self.instance, self.tasks)
        self.assertEqual(plan['version'], 1)
        self.assertEqual([s['agents'][0]['id'] for s in plan['workflow']['stages']],
                         ['first', 'second'])

    def test_invalid_mapping_and_schedule_rejected(self):
        for tasks in [{}, {**self.tasks, '0': {'id': 'dummy', 'prompt': 'x'}},
                      {**self.tasks, '2': {'id': 'first', 'prompt': 'duplicate'}}]:
            with self.assertRaises(ValueError):
                make_plan(self.schedule, self.instance, tasks)
        self.schedule.start_times[2] = 0
        with self.assertRaises(ValueError):
            make_plan(self.schedule, self.instance, self.tasks)


if __name__ == '__main__':
    unittest.main()
