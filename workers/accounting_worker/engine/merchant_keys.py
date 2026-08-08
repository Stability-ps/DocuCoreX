"""Whether a string is specific enough to become a workspace learned rule.

A learned rule is applied to every future transaction in its workspace, so an
insufficiently specific key is not a small mistake. In production the key "d" —
normalised from the alias "mr d" of the seeded merchant "Mr D Food" — matched
425 of 615 rows on a real 37-page statement and booked them all to Meals &
Groceries, including OVERDRAFT SERVICE FEE. Two faults compounded: the key was
one character, and it was applied with `key in description` rather than a
boundary match.

This module answers the first. engine/classification.keyword_matches answers the
second. Both are needed: a safe key applied as a raw substring is still wrong,
and a boundary match on "d" would still match the word "d".

The policy lives in merchant_key_policy.json and is read by TypeScript too, so
what may be CREATED and what may be APPLIED cannot drift apart.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

_POLICY_FILE = Path(__file__).with_name("merchant_key_policy.json")


@lru_cache(maxsize=1)
def _policy() -> dict:
    return json.loads(_POLICY_FILE.read_text())


@lru_cache(maxsize=1)
def _stoplist() -> frozenset[str]:
    return frozenset(_policy()["stoplist"])


def merchant_key_rejection(key: str | None) -> str | None:
    """Why this key may not become a learned rule, or None if it may.

    Returning the reason rather than a boolean keeps the decision explainable:
    a rule refused at creation can tell the user why, and an existing rule
    skipped at application can be reported rather than silently ignored.
    """
    text = " ".join((key or "").split()).lower()
    if not text:
        return "empty"

    policy = _policy()
    if len(text) < int(policy["minLength"]):
        return f"too_short:{len(text)}<{policy['minLength']}"

    tokens = [token for token in re.split(r"[^a-z0-9#*]+", text) if token]
    if not tokens:
        return "no_usable_tokens"

    # Every token being a generic or payment-channel word means the key
    # describes a mechanism, not a counterparty: "card purchase", "payment to".
    if all(token in _stoplist() for token in tokens):
        return f"all_generic:{','.join(tokens)}"

    # At least one token has to be substantial enough to name someone. "d food"
    # is carried by "food"; "d f" is carried by nothing.
    minimum = int(policy["minAlphaTokenLength"])
    substantial = [
        token for token in tokens
        if len(token) >= minimum and token not in _stoplist() and not token.isdigit()
    ]
    if not substantial:
        return f"no_substantial_token:{','.join(tokens)}"

    return None


def is_safe_merchant_key(key: str | None) -> bool:
    return merchant_key_rejection(key) is None
