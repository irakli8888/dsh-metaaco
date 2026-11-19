import unittest

from stock_experience_replay import replay, route_key


class ExperienceReplayTests(unittest.TestCase):
    def test_identity_ignores_dispatch_order_and_preserves_model_assignment(self):
        a = {'id': 'implement', 'dependsOn': [], 'model': {'provider': 'offline', 'model': 'cheap'}}
        b = {'id': 'refactor', 'dependsOn': ['implement'], 'model': {'provider': 'offline', 'model': 'strong'}}
        self.assertEqual(route_key([a, b]), route_key([b, a]))
        changed = {**a, 'model': {'provider': 'offline', 'model': 'strong'}}
        self.assertNotEqual(route_key([a, b]), route_key([changed, b]))

    def test_incomplete_experience_rejects_before_search(self):
        with self.assertRaisesRegex(ValueError, '1836'):
            replay([])
