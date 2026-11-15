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
