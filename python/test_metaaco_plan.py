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
        plan = make_plan(self.schedule, self.instance, self.tasks, execution="serial-order")
        self.assertEqual(plan['version'], 1)
        self.assertEqual([s['agents'][0]['id'] for s in plan['workflow']['stages']],
                         ['first', 'second'])

    def test_parallel_groups_preserve_resource_and_dependency_barriers(self):
        from rcpsp.core import RcpspInstance, SerialScheduleGenerator
        # Two concurrent jobs share a resource; a zero-duration connector precedes the join.
        inst = RcpspInstance(5, 1, [0, 2, 3, 0, 1], [[0], [1], [1], [0], [2]],
                             [2], [[1, 2], [3], [4], [4], []], [[], [0], [0], [1], [2, 3]])
        schedule = SerialScheduleGenerator().generate(inst, [0, 1, 2, 3, 4])
        tasks = {str(j): {'id': f'job-{j}', 'prompt': 'work'} for j in [1, 2, 4]}
        plan = make_plan(schedule, inst, tasks)
        self.assertEqual(plan['execution'], 'start-groups')
        self.assertEqual([[t['id'] for t in s['agents']] for s in plan['workflow']['stages']],
                         [['job-1', 'job-2'], ['job-4']])
        schedule.start_times[4] = 0
        with self.assertRaises(ValueError):
            make_plan(schedule, inst, tasks)

    def test_different_start_times_stay_in_separate_barrier_groups(self):
        from rcpsp.core import RcpspInstance, SerialScheduleGenerator
        inst = RcpspInstance(3, 1, [3, 1, 1], [[1], [1], [1]], [2],
                             [[], [2], []], [[], [], [1]])
        schedule = SerialScheduleGenerator().generate(inst, [0, 1, 2])
        self.assertEqual(schedule.start_times, [0, 0, 1])
        tasks = {str(j): {'id': f'job-{j}', 'prompt': 'work'} for j in range(3)}
        plan = make_plan(schedule, inst, tasks)
        self.assertEqual([len(s['agents']) for s in plan['workflow']['stages']], [2, 1])
        with self.assertRaises(ValueError):
            make_plan(schedule, inst, tasks, execution='timed')

    def test_resource_overcommit_is_rejected_before_export(self):
        from rcpsp.core import RcpspInstance, SerialScheduleGenerator
        inst = RcpspInstance(2, 1, [2, 2], [[1], [1]], [1], [[], []], [[], []])
        schedule = SerialScheduleGenerator().generate(inst, [0, 1])
        schedule.start_times[1] = 0
        tasks = {str(j): {'id': f'job-{j}', 'prompt': 'work'} for j in range(2)}
        with self.assertRaises(ValueError):
            make_plan(schedule, inst, tasks)

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
