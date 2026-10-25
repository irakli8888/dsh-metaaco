"""Real-solver tests for the agent slot resource model and CLI."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

source = os.environ.get('METAACO_SOURCE')
if source:
    sys.path.insert(0, source)
from agent_problem import build_problem, plan_problem

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(source, 'Set METAACO_SOURCE to the actual MetaACO repository')
class AgentProblemTests(unittest.TestCase):
    def setUp(self):
        self.problem = json.loads((ROOT / 'examples/agent-tasks.json').read_text())

    def test_mapping_uses_one_renewable_agent_slot_per_task(self):
        inst, mapping = build_problem(self.problem)
        self.assertEqual(inst.capacities, [2])
        self.assertEqual(inst.demands, [[1], [1], [1]])
        self.assertEqual(inst.durations, [30, 20, 10])
        self.assertEqual(inst.predecessors, [[], [], [0, 1]])
        self.assertEqual(mapping['2']['id'], 'review')

    def test_real_solver_metrics_and_capacity(self):
        parallel = plan_problem(self.problem)
        self.assertEqual(parallel['version'], 2)
        self.assertEqual(parallel['resources'], {'agentSlots': 2})
        self.assertEqual(parallel['estimates'], {'objective': 'makespan', 'durationUnit': 'seconds',
                                               'scheduleMakespan': 40, 'executionMakespan': 40})
        self.assertEqual([len(s['agents']) for s in parallel['workflow']['stages']], [2, 1])
        serial = plan_problem(self.problem, execution='serial-order')
        self.assertEqual(serial['estimates']['executionMakespan'], 60)
        self.problem['maxConcurrentAgents'] = 1
        limited = plan_problem(self.problem)
        self.assertEqual(limited['estimates']['scheduleMakespan'], 60)
        self.assertTrue(all(len(s['agents']) == 1 for s in limited['workflow']['stages']))

    def test_barrier_estimate_is_separate_from_solver_objective(self):
        # A long independent job overlaps B -> C; barriers delay C until A finishes.
        self.problem['tasks'][2]['dependsOn'] = ['inspect-tests']
        p = plan_problem(self.problem)
        self.assertEqual(p['estimates']['scheduleMakespan'], 30)
        self.assertEqual(p['estimates']['executionMakespan'], 40)

    def test_rejects_invalid_inputs_and_unsupported_resources(self):
        for change in [lambda p: p.update(maxConcurrentAgents=True),
                       lambda p: p.update(maxConcurrentAgents=0),
                       lambda p: p.update(maxConcurrentAgents=1.5),
                       lambda p: p.update(version=True),
                       lambda p: p.update(tokenBudget=1000),
                       lambda p: p.update(tasks=[]),
                       lambda p: p['tasks'][0].update(estimatedDurationSeconds=0),
                       lambda p: p['tasks'][0].update(estimatedDurationSeconds=True),
                       lambda p: p['tasks'][0].update(estimatedDurationSeconds=1.5),
                       lambda p: p['tasks'][0].update(estimatedDurationSeconds=2**53),
                       lambda p: p['tasks'][0].update(prompt=' '),
                       lambda p: p['tasks'][0].update(id='review'),
                       lambda p: p['tasks'][0].update(dependsOn=['missing']),
                       lambda p: p['tasks'][0].update(dependsOn=['inspect-code']),
                       lambda p: p['tasks'][2].update(dependsOn=['inspect-code', 'inspect-code']),
                       lambda p: p['tasks'][0].update(dependsOn=['review'])]:
            p = copy.deepcopy(self.problem)
            change(p)
            with self.subTest(problem=p), self.assertRaises(ValueError):
                build_problem(p)

    def test_cli_emits_only_json_and_requires_the_real_solver(self):
        command = [sys.executable, '-B', str(ROOT / 'python/metaaco_plan.py'),
                   '--source', source, '--problem', str(ROOT / 'examples/agent-tasks.json')]
        run = subprocess.run(command, capture_output=True, text=True, check=True)
        p = json.loads(run.stdout)
        self.assertEqual(p['resources']['agentSlots'], 2)
        # Isolated subprocess cannot import an external solver when source is missing.
        command[command.index('--source') + 1] = str(ROOT / 'work/nonexistent-metaaco')
        environment = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
        run = subprocess.run(command, capture_output=True, text=True, env=environment)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, '')
        self.assertIn('no fallback solver', run.stderr)


if __name__ == '__main__':
    unittest.main()
