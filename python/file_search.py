"""Bounded file retrieval and contextual routing over one local text snapshot."""

from collections import defaultdict
from functools import lru_cache
import json
from pathlib import PurePosixPath
import re
from time import perf_counter_ns

LIMIT = 3
FIXED = ("path", "text", "follow")
WORD = re.compile(r"[^\W_]+", re.UNICODE)
CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
FILENAME = re.compile(r"(?<![\w.])(?:[\w-]+/)*[\w-]+(?:\.[a-zA-Z][\w-]{0,14})+\b")
IDENTIFIER = re.compile(r"\b(?:[a-zA-Z]\w*_\w+|[a-z]+[A-Z]\w*|[A-Z][a-z]+[A-Z]\w*)\b")
DECLARATION = re.compile(r"\b(?:def|class|interface|function|type|struct|enum|const|fn)\s+(\w+)")
CALL = re.compile(r"\b([a-zA-Z_]\w{3,})\(")
STOPWORDS = set(("a an and are at by can code does file find for from how in is it of on or "
                 "the that this to use what when where which who with defined implemented "
                 "implementation called declaration где как файл код какой находится "
                 "реализован реализована функция после").split())
TRANSLATIONS = {
    "рассчитывается": "calculate", "свободный": "available", "ресурс": "resource",
    "перераспределения": "allocation", "ресурсов": "resources",
    "проверяется": "validate", "расписание": "schedule",
    "превышение": "exceeds", "доступных": "available",
}


def words(value):
    return frozenset(TRANSLATIONS.get(word.lower(), word.lower())
                     for token in WORD.findall(value)
                     for word in (token, *CAMEL.split(token))
                     if len(word) > 1 and word.lower() not in STOPWORDS)


def classify(query):
    if FILENAME.search(query):
        return "file"
    if IDENTIFIER.search(query):
        return "identifier"
    return "description"


class SearchSnapshot:
    """Mutable forward/inverted index, with a bounded cache scoped to this object."""

    def __init__(self, documents):
        self.documents = {}
        self.declarations = {}
        self.forward = {action: {} for action in FIXED}
        self.postings = {action: defaultdict(set) for action in FIXED}
        self.search = lru_cache(maxsize=2048)(self._search)
        self.update(documents)

    def update(self, changes):
        self.search.cache_clear()
        for path, text in changes.items():
            self.documents.pop(path, None)
            self.declarations.pop(path, None)
            for action in FIXED:
                for term in self.forward[action].pop(path, {}):
                    paths = self.postings[action][term]
                    paths.remove(path)
                    if not paths:
                        del self.postings[action][term]
            if text is None:
                continue
            lines = tuple(text.splitlines())
            self.documents[path] = lines
            declarations = self.declarations[path] = {}
            columns = {"path": {term: (0,) for term in words(path)},
                       "text": defaultdict(list), "follow": defaultdict(list)}
            for number, line in enumerate(lines, 1):
                for term in words(line):
                    columns["text"][term].append(number)
                declared = DECLARATION.findall(line)
                if declared:
                    declarations[number] = frozenset(symbol.casefold() for symbol in declared)
                    for term in frozenset().union(*(words(symbol) for symbol in declared)):
                        columns["follow"][term].append(number)
            for action, column in columns.items():
                self.forward[action][path] = column
                for term in column:
                    self.postings[action][term].add(path)

    def _search(self, indexed, action, terms, filenames, symbols):
        if indexed:
            paths = set().union(*(self.postings[action].get(term, ()) for term in terms))
        else:
            paths = self.forward[action]
        found = []
        for path in paths:
            column = self.forward[action][path]
            matched = terms.intersection(column)
            if not matched:
                continue
            lines = self.documents[path]
            if action == "path":
                exact = (path.casefold() in filenames or
                         PurePosixPath(path).name.casefold() in filenames)
                number = next((i for i, line in enumerate(lines, 1) if line.strip()), 0)
                score = 3 * len(matched) + 40 * exact
            else:
                hits = defaultdict(int)
                for term in matched:
                    for number in column[term]:
                        hits[number] += 1
                declarations = self.declarations[path]
                line_scores = {number: 3 * hits_on_line + 16 * (not symbols.isdisjoint(
                    declarations.get(number, ()))) for number, hits_on_line in hits.items()}
                number = min(line_scores, key=lambda n: (-line_scores[n], n))
                score = 2 * len(matched) + line_scores[number] + (2 if action == "follow" else 0)
            found.append((score, path, number))
        return len(found), tuple(sorted(found, key=lambda x: (-x[0], x[1]))[:32])


def run_search(snapshot, query, *, indexed=True, policy=None):
    started = perf_counter_ns()
    context = classify(query)
    terms = words(query)
    filenames = frozenset(match.casefold() for match in FILENAME.findall(query))
    symbols = frozenset(match.casefold() for match in IDENTIFIER.findall(query))
    rankings, steps = {}, []
    remaining = set(FIXED)
    state, stop = "start", "step_limit"
    while remaining and len(steps) < LIMIT:
        step_started = perf_counter_ns()
        orders = (policy or {}).get(context)
        order = orders[("start", "strong", "weak").index(state)] if orders else FIXED
        action = next(action for action in order if action == "stop" or action in remaining)
        if action == "stop":
            stop = "policy_stop"
            break
        remaining.remove(action)
        step_terms, step_symbols = terms, symbols
        if action == "follow":
            # Use observed calls from the leading candidates to look up declarations.
            hints = set()
            for _, path, number in sorted(rankings.values(), key=lambda x: (-x[0], x[1]))[:3]:
                if number:
                    for symbol in CALL.findall(snapshot.documents[path][number - 1]):
                        if words(symbol) & terms:
                            hints.add(symbol)
            step_terms = terms.union(*(words(hint) for hint in hints))
            step_symbols = symbols.union(hint.casefold() for hint in hints)
        before = snapshot.search.cache_info().hits
        count, found = snapshot.search(indexed, action, step_terms, filenames, step_symbols)
        for item in found:
            score, path, _ = item
            if path not in rankings or score > rankings[path][0]:
                rankings[path] = item
        steps.append({"action": action, "state": state, "matches": count,
                      "terms": sorted(step_terms), "symbols": sorted(step_symbols),
                      "cache_hit": snapshot.search.cache_info().hits > before,
                      "ms": (perf_counter_ns() - step_started) / 1e6})
        state = "strong" if 0 < count <= 5 else "weak"
    files = [{"path": path, "line": number or None,
              "snippet": snapshot.documents[path][number - 1].strip()[:240] if number else "",
              "score": score}
             for score, path, number in sorted(rankings.values(), key=lambda x: (-x[0], x[1]))[:5]]
    # Include the cost of formatting the final answer for downstream callers.
    json.dumps(files, ensure_ascii=False)
    return {"files": files, "steps": steps, "stop": stop,
            "ms": (perf_counter_ns() - started) / 1e6,
            "model_calls": 0, "model_input_bytes": 0, "input_tokens": 0, "output_tokens": 0}
