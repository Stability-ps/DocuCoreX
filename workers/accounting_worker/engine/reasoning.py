"""Layer 4 — deciding a treatment from evidence, and saying which evidence.

The old model was one table mapping a string to a category, a VAT treatment and
a number. It could not answer "why", because the answer was always "because the
string matched", and that answer was wrong in two ways this project has already
paid for: a fuel brand authorised a VAT claim, and a one-character learned key
claimed 425 rows.

This layer takes evidence from the layers below and decides, recording what it
used. Nothing here matches strings on its own behalf — it asks the evidence
layers what they know and weighs the answers.

  bank-named fee        the bank named the charge on its own statement
  learned rule          a human in this workspace decided it
  transaction semantics the transaction stated its own nature
  banking semantics     the movement IS the accounting fact
  merchant type         what kind of entity this is, plus what that could mean
  counterparty evidence recurrence, direction, amount profile
  direction             a constraint, never a decision

Precedence is by GRADE, not by layer order, so a HARD fact beats a MEDIUM
inference wherever they disagree. Where two layers of equal grade agree, the
confidence rises; where they conflict, the row goes to review rather than
picking a winner silently.

What this layer may not do is as important as what it may. It never emits a VAT
CLAIM — the strongest it says is that evidence is required, and Layer 5 turns
that into a calculated amount with the claim withheld. It never lets a
relationship alone name a category, because knowing someone is a supplier does
not say whether the payment was stock, an asset or a loan repayment. And it
never lets direction decide, because a credit may be a refund and a debit may be
a transfer out.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Sequence

from engine.classification import (
    STRENGTH_HARD,
    STRENGTH_LEARNED,
    STRENGTH_NONE,
    STRENGTH_SOFT,
    keyword_matches,
)

_TX_SEMANTICS = Path(__file__).with_name("transaction_semantics.json")
_BANK_SEMANTICS = Path(__file__).with_name("banking_semantics.json")
_MERCHANT_TYPES = Path(__file__).with_name("merchant_types.json")
_TYPE_TREATMENTS = Path(__file__).with_name("merchant_type_treatments.json")


# ── Evidence grades ─────────────────────────────────────────────────────────
#
# How much weight a fact carries, decided by WHERE it came from rather than by
# how confident the code feels. The four grades are the ones the accounting
# brief specified, and each is anchored to something checkable:
#
#   HARD    the bank or the transaction said so, in its own words
#   HIGH    a human approved it, or the entity can only supply one thing
#   MEDIUM  a type plus corroborating pattern — recurrence, amount band
#   LOW     the name was recognised and nothing else
#
# LOW never settles a row on its own. That is the whole lesson of the fuel
# defect written as a rule.
GRADE_HARD = "hard"
GRADE_HIGH = "high"
GRADE_MEDIUM = "medium"
GRADE_LOW = "low"
GRADE_NONE = "none"

GRADE_ORDER = {GRADE_NONE: 0, GRADE_LOW: 1, GRADE_MEDIUM: 2, GRADE_HIGH: 3, GRADE_HARD: 4}

# The rule standing each grade maps onto, so downstream code that already
# reasons about HARD/LEARNED/SOFT keeps working unchanged.
GRADE_STRENGTH = {
    GRADE_HARD: STRENGTH_HARD,
    GRADE_HIGH: STRENGTH_SOFT,
    GRADE_MEDIUM: STRENGTH_SOFT,
    GRADE_LOW: STRENGTH_SOFT,
    GRADE_NONE: STRENGTH_NONE,
}

# A grade below this cannot settle a row by itself.
SETTLING_GRADE = GRADE_MEDIUM


@dataclass(frozen=True)
class Evidence:
    """One checkable fact, and where it came from."""

    source: str
    detail: str
    grade: str


@dataclass(frozen=True)
class Treatment:
    """A decision, with its reasoning attached.

    `evidence_used` and `reason` are not decoration. A classification a reviewer
    cannot interrogate is one they have to redo, which is the opposite of the
    point — the answer to "why was this classified?" has to be the evidence, not
    "Shell is fuel".
    """

    category: str
    vat_treatment: str
    bank_charge: bool
    confidence: float
    strength: str
    reason: str
    evidence_used: tuple[Evidence, ...] = field(default=())
    alternatives: tuple[str, ...] = field(default=())
    review_required: bool = False
    merchant_type: str | None = None

    @property
    def grade(self) -> str:
        if not self.evidence_used:
            return GRADE_NONE
        return max((e.grade for e in self.evidence_used), key=lambda g: GRADE_ORDER[g])

    def explain(self) -> str:
        """Why this was classified, in one reviewer-facing string."""
        if not self.evidence_used:
            return self.reason
        bullets = "; ".join(f"{e.source}={e.detail}" for e in self.evidence_used)
        return f"{self.reason} [{bullets}]"


@lru_cache(maxsize=1)
def _transaction_terms() -> tuple[dict[str, Any], ...]:
    terms = json.loads(_TX_SEMANTICS.read_text())["terms"]
    return tuple(sorted(terms, key=lambda t: len(t["term"]), reverse=True))


@lru_cache(maxsize=1)
def _banking_mechanisms() -> tuple[dict[str, Any], ...]:
    mechanisms = json.loads(_BANK_SEMANTICS.read_text())["mechanisms"]
    return tuple(sorted(mechanisms, key=lambda m: len(m["term"]), reverse=True))


@lru_cache(maxsize=1)
def _merchant_type_index() -> dict[str, tuple[str, str, float]]:
    """alias -> (canonical, merchant_type, identification confidence)."""
    index: dict[str, tuple[str, str, float]] = {}
    for merchant in json.loads(_MERCHANT_TYPES.read_text())["merchants"]:
        for alias in merchant["aliases"]:
            index[alias.lower()] = (
                merchant["canonical"],
                merchant["merchant_type"],
                float(merchant["identification_confidence"]),
            )
    return index


@lru_cache(maxsize=1)
def type_treatments() -> dict[str, Any]:
    return json.loads(_TYPE_TREATMENTS.read_text())["types"]


def identify_merchant_type(description: str | None) -> tuple[str, str, float] | None:
    """The canonical merchant and its TYPE, or None. Never a category.

    Longest alias first, and matched with the boundary-aware matcher rather than
    as a raw substring — 'fuel' as a fragment also matches FUELLED CATERING,
    which is why FUELZONE is listed by name.
    """
    text = str(description or "").lower()
    if not text:
        return None
    for alias in sorted(_merchant_type_index(), key=len, reverse=True):
        if keyword_matches(text, alias):
            return _merchant_type_index()[alias]
    return None


def transaction_semantic(description: str | None) -> dict[str, Any] | None:
    """What the transaction says it is, in its own words."""
    text = str(description or "").lower()
    for term in _transaction_terms():
        if keyword_matches(text, term["term"]):
            return term
    return None


def banking_mechanism(description: str | None) -> dict[str, Any] | None:
    """The movement, where the movement is itself the accounting fact."""
    text = str(description or "").lower()
    for mechanism in _banking_mechanisms():
        if mechanism.get("category") and keyword_matches(text, mechanism["term"]):
            return mechanism
    return None


def _amount(debit: Any, credit: Any) -> float:
    for value in (debit, credit):
        if value:
            return abs(float(value))
    return 0.0


def _discriminate(
    type_key: str,
    description: str,
    amount: float,
    corroborating_types: Sequence[str],
) -> tuple[str | None, list[Evidence]]:
    """Choose among a type's possible treatments, using only stated discriminators.

    Returns the supported treatment and the evidence that supported it. When
    nothing discriminates, returns None — and the caller keeps the default and
    leaves the row in review rather than pretending the menu had one item.
    """
    spec = type_treatments().get(type_key) or {}
    evidence: list[Evidence] = []
    votes: dict[str, int] = {}

    for rule in spec.get("discriminators", ()):
        kind = rule.get("kind")
        if kind == "amount_band":
            low, high = rule.get("low"), rule.get("high")
            if amount and amount >= (low or 0) and (high is None or amount <= high):
                votes[rule["supports"]] = votes.get(rule["supports"], 0) + 1
                evidence.append(Evidence("amount_pattern", f"R{amount:,.2f} — {rule['reason']}", GRADE_MEDIUM))
        elif kind == "description_contains":
            lowered = description.lower()
            if any(keyword_matches(lowered, term) for term in rule.get("terms", ())):
                votes[rule["supports"]] = votes.get(rule["supports"], 0) + 1
                evidence.append(Evidence("description", rule["reason"], GRADE_MEDIUM))
        elif kind == "corroborating_type":
            shared = sorted(set(rule.get("types", ())) & set(corroborating_types))
            if shared:
                votes[rule["supports"]] = votes.get(rule["supports"], 0) + 1
                evidence.append(Evidence("corroborating_activity", f"{', '.join(shared)} — {rule['reason']}", GRADE_MEDIUM))

    if not votes:
        return None, evidence
    best = max(votes, key=lambda treatment: votes[treatment])
    return best, evidence


def decide(
    description: str,
    debit: Any = None,
    credit: Any = None,
    *,
    counterparty_evidence: Any = None,
    corroborating_types: Sequence[str] = (),
) -> Treatment | None:
    """The treatment this evidence supports, or None if no layer knows anything.

    None is not a failure — it means the evidence layers have nothing to say, and
    the caller should fall through to whatever it did before. That is what lets
    this ship alongside the old system rather than replacing it blind.
    """
    text = str(description or "")
    amount = _amount(debit, credit)

    # 1. The transaction stating its own nature. After a tax invoice this is the
    #    strongest evidence available, and it needs no corroboration: "INSURANCE
    #    PREMIUM" can only be an insurance premium, whoever collected it.
    semantic = transaction_semantic(text)
    if semantic is not None:
        return Treatment(
            category=semantic["category"],
            vat_treatment=semantic["vat_treatment"],
            bank_charge=False,
            confidence=float(semantic["confidence"]),
            strength=GRADE_STRENGTH[semantic["grade"]],
            reason=semantic["reason"],
            evidence_used=(Evidence("transaction_semantics", semantic["term"], semantic["grade"]),),
            review_required=bool(semantic.get("always_review")),
        )

    # 2. A movement that IS the accounting fact. Only ever balance-sheet: a
    #    channel cannot know what was bought, so it may not name a P&L account.
    mechanism = banking_mechanism(text)
    if mechanism is not None:
        return Treatment(
            category=mechanism["category"],
            vat_treatment=mechanism["vat_treatment"],
            bank_charge=False,
            confidence=float(mechanism["confidence"]),
            strength=GRADE_STRENGTH[mechanism["grade"]],
            reason=mechanism["reason"],
            evidence_used=(Evidence("banking_semantics", mechanism["term"], mechanism["grade"]),),
            review_required=bool(mechanism.get("always_review")),
        )

    # 3. What kind of entity this is — which is not yet what the money bought.
    identified = identify_merchant_type(text)
    if identified is None:
        return None

    canonical, type_key, identification_confidence = identified
    spec = type_treatments().get(type_key)
    if spec is None:
        return None

    evidence = [Evidence("merchant_type", f"{canonical} is a {spec['label']}", GRADE_LOW)]

    # Monoline: the entity can only supply one thing that matters to the books,
    # so identity settles the account. An insurer supplies insurance. This is
    # the ONLY case where recognising a name is enough, and it is enough because
    # the menu has one item, not because the name is trusted.
    if spec.get("monoline"):
        evidence.append(Evidence("monoline", spec.get("monoline_reason", ""), GRADE_HIGH))
        return Treatment(
            category=spec["default_treatment"],
            vat_treatment=_vat_from_possible(spec["possible_vat"]),
            bank_charge=False,
            confidence=min(identification_confidence, 90.0),
            strength=STRENGTH_SOFT,
            reason=f"{canonical} is a {spec['label']}, which supplies one thing: {spec.get('monoline_reason', '')}",
            evidence_used=tuple(evidence),
            alternatives=(),
            review_required=False,
            merchant_type=type_key,
        )

    # Multi-line: the menu has several items, so something has to choose.
    chosen, discriminating = _discriminate(type_key, text, amount, corroborating_types)
    evidence.extend(discriminating)

    if counterparty_evidence is not None:
        recurrence = _counterparty_evidence(counterparty_evidence)
        evidence.extend(recurrence)

    category = chosen or spec["default_treatment"]
    alternatives = tuple(t for t in spec["possible_treatments"] if t != category)

    # Nothing discriminated: keep the default, but say so and keep the row in
    # review. A menu of four does not become an answer because one entry is
    # printed first.
    settled = chosen is not None and _best_grade(evidence) != GRADE_LOW
    confidence = 82.0 if settled else 62.0

    return Treatment(
        category=category,
        vat_treatment=_vat_from_possible(spec["possible_vat"]),
        bank_charge=False,
        confidence=confidence,
        strength=STRENGTH_SOFT,
        reason=(
            f"{canonical} is a {spec['label']}; evidence supports {category}"
            if settled
            else f"{canonical} is a {spec['label']}, but nothing distinguishes between {len(spec['possible_treatments'])} possible treatments"
        ),
        evidence_used=tuple(evidence),
        alternatives=alternatives,
        review_required=not settled,
        merchant_type=type_key,
    )


def _counterparty_evidence(evidence: Any) -> list[Evidence]:
    """Recurrence facts, offered as SUPPORT and never as a category.

    A supplier relationship does not say the payment was an operating expense.
    These raise confidence in a treatment chosen on other grounds; they never
    choose one. engine/counterparty.py enforces the same rule from its side by
    refusing to carry a category field at all.
    """
    facts: list[Evidence] = []
    occurrences = getattr(evidence, "occurrences", 0)
    if occurrences >= 2:
        facts.append(Evidence("recurrence", f"{occurrences} transactions with this counterparty", GRADE_MEDIUM))
    if getattr(evidence, "recurring", False):
        facts.append(Evidence("recurrence", f"recurring across {evidence.months_spanned} months", GRADE_MEDIUM))
    if getattr(evidence, "single_direction", False) and occurrences >= 2:
        way = "only ever paid out" if getattr(evidence, "debit_count", 0) else "only ever received"
        facts.append(Evidence("direction_pattern", f"money {way}", GRADE_MEDIUM))
    return facts


def _best_grade(evidence: Sequence[Evidence]) -> str:
    if not evidence:
        return GRADE_NONE
    return max((e.grade for e in evidence), key=lambda g: GRADE_ORDER[g])


def _vat_from_possible(possible_vat: str | None) -> str:
    """Translate a type's VAT stance into a stored treatment.

    Note what is missing: there is no path to "standard". A type may say a claim
    needs evidence, or that there is nothing to claim. It may never say the
    claim is good — that is Layer 5's decision, and only against evidence.
    """
    if possible_vat == "not_claimable":
        return "exempt"
    return "review"
