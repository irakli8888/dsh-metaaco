"""Decode an ant's priority order into one choice per decision group."""


def decode_order(groups, order):
    """Use the first encountered alternative in each group.

    Alternatives have globally unique IDs. The order must contain all alternatives,
    allowing the existing permutation-based search to represent every assignment.
    Feasibility and scoring of the resulting workflow belong to the graph decoder.
    """
    owners = {}
    for decision, alternatives in groups.items():
        if not alternatives:
            raise ValueError('Each decision needs at least one alternative')
        for alternative in alternatives:
            if alternative in owners:
                raise ValueError('Duplicate decision alternative')
            owners[alternative] = decision
    if len(order) != len(owners) or set(order) != set(owners):
        raise ValueError('Expected a permutation of decision alternatives')
    choices = {}
    for alternative in order:
        choices.setdefault(owners[alternative], alternative)
    return choices
