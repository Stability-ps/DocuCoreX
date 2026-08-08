"""The accounting category vocabulary, loaded from the one canonical file.

Four different vocabularies had grown apart: what classify_transaction stored
(29 strings), what professional_account and the AI produced, what the review
dropdown offered (27), and what the AI validator accepted (33). Their union was
46 distinct strings. Eleven categories the worker wrote could not be selected by
a reviewer at all, nine dropdown options were produced by nothing, and the same
account appeared under several spellings — "Insurance" and "Insurance Expense",
"SARS / Tax Suspense" and "Tax / SARS Suspense", "Courier / Freight" and
"Courier / Delivery".

That is not a cosmetic problem. A reviewer cannot correct a category the
dropdown does not contain, and a correction made in one spelling trains a
learned rule the other side does not recognise.

categories.json is the single source. TypeScript imports the same file, so the
two languages cannot drift; a test in each language pins the parity.

Ids are the STORED values, and were chosen to be the professional-chart strings
wherever one existed, so the majority of existing rows already match. Aliases
are historical spellings: accepted on read and rendered correctly, never written.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_CATEGORY_FILE = Path(__file__).with_name("categories.json")


@lru_cache(maxsize=1)
def _load() -> dict:
    return json.loads(_CATEGORY_FILE.read_text())


@lru_cache(maxsize=1)
def canonical_categories() -> tuple[str, ...]:
    """Every category that may be stored, in presentation order."""
    return tuple(entry["id"] for entry in _load()["categories"])


@lru_cache(maxsize=1)
def category_labels() -> dict[str, str]:
    return {entry["id"]: entry["label"] for entry in _load()["categories"]}


@lru_cache(maxsize=1)
def _alias_index() -> dict[str, str]:
    index: dict[str, str] = {}
    for entry in _load()["categories"]:
        index[entry["id"].casefold()] = entry["id"]
        for alias in entry.get("aliases", ()):
            index[alias.casefold()] = entry["id"]
    return index


def canonicalise_category(value: str | None) -> str | None:
    """Map any known spelling to its canonical id, or None if unrecognised.

    Case- and whitespace-insensitive, because the difference between
    "Bank Charges" and "bank charges " is a typo, not a different account.
    Returns None rather than a guess: an unrecognised category is a fact worth
    surfacing, and silently coercing it to Uncategorised would hide it.
    """
    if not value:
        return None
    return _alias_index().get(" ".join(str(value).split()).casefold())


def is_canonical_category(value: str | None) -> bool:
    """True only for a value already in canonical form — aliases are not."""
    return bool(value) and value in set(canonical_categories())


def is_known_category(value: str | None) -> bool:
    """True for a canonical id or any historical alias of one."""
    return canonicalise_category(value) is not None


@lru_cache(maxsize=1)
def unresolved_categories() -> frozenset[str]:
    """Categories that mean "nothing could determine this", not a decision.

    Flagged explicitly in categories.json rather than matched by pattern. A
    regex over "review|suspense|uncategori" also catches
    "Meals / Groceries - Non Deductible Review", "SARS / Tax Suspense" and
    "Refund / Suspense" — all real decisions a reviewer can act on — so a
    pattern would quietly demote three genuine classifications.
    """
    return frozenset(
        category["id"] for category in _load()["categories"] if category.get("unresolved")
    )


def is_unresolved_category(value: str | None) -> bool:
    """Whether a category is a parking bucket rather than an accounting answer.

    Canonicalises first, so an alias of a parking bucket is recognised as one.
    """
    canonical = canonicalise_category(value)
    return canonical is not None and canonical in unresolved_categories()
