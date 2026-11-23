import unittest

from file_search import SearchSnapshot, classify, run_search


class SearchTest(unittest.TestCase):
    def test_scan_and_index_share_ranking_and_evidence(self):
        snapshot = SearchSnapshot({
            "src/api.py": "from .core import free_capacity\nfree_capacity()",
            "src/core.py": "def free_capacity():\n    return total - assigned",
        })
        query = "Where is free_capacity implemented?"
        indexed = run_search(snapshot, query)
        scanned = run_search(snapshot, query, indexed=False)
        self.assertEqual(indexed["files"], scanned["files"])
        self.assertEqual(indexed["files"][0]["path"], "src/core.py")
        self.assertEqual(indexed["files"][0]["line"], 1)
        self.assertEqual(len(indexed["steps"]), 3)

    def test_snapshot_update_removes_stale_postings_and_cache(self):
        snapshot = SearchSnapshot({"a.txt": "orchard", "b.txt": "river"})
        self.assertEqual(run_search(snapshot, "orchard")["files"][0]["path"], "a.txt")
        snapshot.update({"a.txt": None, "b.txt": "orchard"})
        self.assertEqual(run_search(snapshot, "orchard")["files"][0]["path"], "b.txt")

    def test_route_can_react_to_intermediate_evidence(self):
        snapshot = SearchSnapshot({"a.txt": "orchard"})
        route = (("text", "path", "follow"), ("stop", "path", "follow", "text"),
                 ("path", "follow", "text"))
        result = run_search(snapshot, "orchard", policy={classify("orchard"): route})
        self.assertEqual([step["action"] for step in result["steps"]], ["text"])
        self.assertEqual(result["stop"], "policy_stop")

    def test_follow_scores_an_identifier_discovered_in_a_call(self):
        snapshot = SearchSnapshot({
            "api.py": "freeCapacity() # available capacity",
            "core.py": "def freeCapacity():\n    return total - assigned",
        })
        result = run_search(snapshot, "Where is available capacity implemented?")
        self.assertIn("freecapacity", result["steps"][-1]["symbols"])
        self.assertEqual(result["files"][0]["path"], "core.py")
