"""Merchant identification from a bank description.

A bank description is noisy on purpose — it carries a card terminal id, a
reference, a branch, a truncated brand: "C*FUELZONE 4278*5999 CHEQUE CARD
PURCHASE", "POS PURCHASE WOOLWORTHS MENLYN 004829". The merchant is in there,
but the string as a whole is evidence and must survive untouched.

So identification is a separate fact, stored separately. `description` stays
exactly as the bank wrote it; `normalized_merchant` records who we think it was.
The reviewer can always see both, and a wrong merchant never destroys the only
record of what the bank actually said.

Matching is boundary-aware, never a raw substring. That distinction is the whole
reason this file exists: "fuel" as a fragment matches FUELLED CATERING as
readily as FUELZONE, so a fuel retailer has to be KNOWN by name rather than
guessed at from letters. Recognising the brand is a fact about the world;
finding four letters inside a word is not.

An unidentified merchant is null. A merchant is a claim about who was paid, and
inventing one to avoid an empty field would put a fabrication in front of an
accountant.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .classification import keyword_matches

_MERCHANT_FILE = Path(__file__).with_name("merchants.json")


@dataclass(frozen=True)
class MerchantMatch:
    """An identified merchant and what it implies about the category."""

    canonical: str
    category: str
    vat_treatment: str
    confidence: float
    reason: str
    matched_alias: str


@lru_cache(maxsize=1)
def _merchants() -> tuple[dict, ...]:
    entries = json.loads(_MERCHANT_FILE.read_text())["merchants"]
    # Longest alias first, so "uber eats" is preferred over a shorter alias of
    # another entry that also happens to appear.
    return tuple(sorted(entries, key=lambda entry: max((len(a) for a in entry["aliases"]), default=0), reverse=True))


@lru_cache(maxsize=1)
def merchant_count() -> int:
    return len(_merchants())


def identify_merchant(description: str) -> MerchantMatch | None:
    """Identify the merchant behind a bank description, or None.

    None is the honest answer for anything not recognised. It is also the common
    one: most descriptions on a real statement name a counterparty nobody has
    taught the system yet, and saying so is what sends the row to a person.
    """
    text = " ".join((description or "").split()).lower()
    if not text:
        return None

    for entry in _merchants():
        for alias in entry["aliases"]:
            if keyword_matches(text, alias):
                return MerchantMatch(
                    canonical=entry["canonical"],
                    category=entry["category"],
                    vat_treatment=entry["vat_treatment"],
                    confidence=float(entry["confidence"]),
                    reason=entry["reason"],
                    matched_alias=alias,
                )
    return None


def merchant_is_grounded(merchant: str | None, description: str) -> bool:
    """True when a proposed merchant name is actually present in the description.

    Used on anything a model suggests. Every substantial word of the merchant
    must appear in the bank's own text; short tokens are ignored so punctuation
    and joining words do not reject a real match. A merchant the description
    does not contain is a fabrication, however plausible it reads.
    """
    if not merchant:
        return False
    import re

    haystack = set(re.sub(r"[^a-z0-9]+", " ", (description or "").lower()).split())
    words = [word for word in re.sub(r"[^a-z0-9]+", " ", merchant.lower()).split() if len(word) >= 3]
    if not words:
        return False
    return all(word in haystack for word in words)
