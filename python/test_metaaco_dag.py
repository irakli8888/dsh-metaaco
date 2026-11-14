import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import metaaco_dag as bridge

ROOT = Path(__file__).resolve().parents[1]
SOURCE = os.environ.get('METAACO_SOURCE')


def problem():
    return {'version': 2, 'plan': {
        'version': 3, 'execution': 'dag', 'name': 'fixture', 'description': 'offline',
        'resources': {'agentSlots': 2, 'maxArtifactBytes': 1024, 'maxInputBytes': 4096, 'timeoutMs': 5000},
        'tasks': [
            {'id': 'slow', 'prompt': 'slow', 'dependsOn': [], 'inputs': [], 'slots': 1, 'model': None},
            {'id': 'fast', 'prompt': 'fast', 'dependsOn': [], 'inputs': [], 'slots': 1, 'model': None},
            {'id': 'child', 'prompt': 'child', 'dependsOn': ['fast'],
             'inputs': [{'name': 'source', 'taskId': 'fast'}], 'slots': 1,
             'model': {'provider': 'offline', 'model': 'fixture'}},
        ]}, 'durationEstimatesSeconds': {'slow': 30, 'fast': 10, 'child': 10}}


@unittest.skipUnless(SOURCE, 'Set METAACO_SOURCE to the real solver')
class MetaacoDagTests(unittest.TestCase):
    def test_real_solver_preserves_bindings_and_separates_estimates(self):
        self.assertTrue(callable(getattr(bridge, 'plan_dag', None)), 'plan_dag API missing')
        p = problem()
        result = bridge.plan_dag(p, SOURCE, seed=42)
        self.assertEqual(result['plan']['version'], 3)
        self.assertEqual(result['estimates']['scheduleMakespan'], 30)
        self.assertIsNone(result['estimates']['executionMakespan'])
        self.assertGreaterEqual(result['measured']['solverWallTimeMs'], 0)
        self.assertLessEqual(result['measured']['evaluations'], 100)
        self.assertEqual({t['id']: t for t in result['plan']['tasks']}, {t['id']: t for t in p['plan']['tasks']})
        self.assertIn('rcpsp/core.py', result['provenance']['sourceFiles'])
        self.assertIn('rcpsp/metaACO.py', result['provenance']['sourceFiles'])
        self.assertTrue(result['provenance']['parameters']['replication_enabled'])
        self.assertTrue(result['provenance']['parameters']['elite_enabled'])
        self.assertTrue(result['provenance']['parameters']['local_search_enabled'])
        again = bridge.plan_dag(p, SOURCE, seed=42)
        self.assertEqual(result['plan'], again['plan'])
        self.assertEqual(result['estimates'], again['estimates'])
        self.assertEqual(p, problem())

    def test_weighted_slots_are_solver_demands(self):
        p = problem()
        p['plan']['tasks'][0]['slots'] = 2
        result = bridge.plan_dag(p, SOURCE)
        self.assertEqual(result['estimates']['scheduleMakespan'], 50)

    def test_time_indexed_solver_horizon_is_bounded_before_allocation(self):
        p = problem()
        p['durationEstimatesSeconds']['slow'] = 86400
        with self.assertRaisesRegex(ValueError, 'horizon'):
            bridge.validate_problem(p)

    def test_invalid_problems_fail_before_search(self):
        changes = [lambda p: p.update(version=True),
                   lambda p: p['durationEstimatesSeconds'].update(slow=True),
                   lambda p: p['durationEstimatesSeconds'].update(slow=0),
                   lambda p: p['durationEstimatesSeconds'].update(extra=1),
                   lambda p: p['durationEstimatesSeconds'].update(slow=2**53),
                   lambda p: p['plan']['tasks'][0].update(slots=3),
                   lambda p: p['plan']['tasks'][0].update(dependsOn=['slow']),
                   lambda p: p['plan']['tasks'][1].update(dependsOn=['child']),
                   lambda p: p['plan']['tasks'][2]['inputs'][0].update(taskId='slow')]
        for change in changes:
            p = problem(); change(p)
            with self.subTest(problem=p), self.assertRaises(ValueError):
                bridge.plan_dag(p, SOURCE)

    def test_source_mismatch_has_no_cached_import_fallback(self):
        bridge.plan_dag(problem(), SOURCE)
        with self.assertRaisesRegex((ValueError, RuntimeError), 'source|fallback'):
            bridge.plan_dag(problem(), str(ROOT / 'missing-solver'))

    def test_cli_reserves_stdout_for_json(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'problem.json'
            path.write_text(json.dumps(problem()))
            run = subprocess.run([sys.executable, '-B', str(ROOT / 'python/metaaco_dag.py'),
                                  '--source', SOURCE, '--problem', str(path), '--seed', '42'],
                                 capture_output=True, text=True, check=True, timeout=10)
            self.assertEqual(json.loads(run.stdout)['planner'], 'python-metaaco-dag')


if __name__ == '__main__':
    unittest.main()
