"""Reasoning about counterparties instead of about transactions.

The row-by-row model asked the same question 615 times and gave the model
almost nothing to answer it with. "WELKOM FRESH P4278*5999 CHEQUE CARD
PURCHASE" is a truncated name, a card mask and a channel. Asked in isolation,
115 separate times, it is unanswerable — and asking it 115 times invites 115
different answers to the same question.

Grouped, it is a different question entirely:

    WELKOM FRESH P
      115 transactions across 6 months
      100% outbound
      R300 to R26,000, median R9,100
      strong supplier relationship

That is answerable, and it is one decision rather than 115. On the real
statement it turns 413 unresolved rows into 99 counterparty questions, of which
40 cover 334 rows.

The evidence is what makes this safe as well as cheap. Requirement: the model
must never see a merchant name and be asked to name a category. It sees what
the statement proves — recurrence, direction, amount profile, period, and where
known the entity type with the treatments that type permits — and its answer is
checked against that same evidence when it comes back.

What the model may decide: which of the permitted treatments the evidence
supports, what kind of entity this looks like, and how confident to be.

What it may not: the amounts, the dates, the descriptions, the direction,
whether a tax invoice exists, whether VAT may be claimed, or any category
outside the canonical vocabulary. Those are not prompt instructions, which a
model may ignore; they are enforced when the answer is validated.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable, Sequence

from engine.categories import canonicalise_category
from engine.reasoning import type_treatments

# One decision per counterparty, so a batch is far smaller than the row-by-row
# equivalent. Twenty groups carry more evidence than 200 rows did.
COUNTERPARTY_BATCH_SIZE = 20

# Below this, a counterparty is a one-off and the group carries no more evidence
# than the row did. Those stay with the row-by-row path.
MIN_OCCURRENCES_FOR_GROUP = 2


@dataclass(frozen=True)
class CounterpartyQuestion:
    """One counterparty, and everything the statement proves about it."""

    key: str
    display: str
    occurrences: int
    months_spanned: int
    direction: str
    total: Decimal
    median: Decimal
    smallest: Decimal
    largest: Decimal
    relationship: str
    relationship_strength: str
    merchant_type: str | None
    permitted_treatments: tuple[str, ...]
    sample_descriptions: tuple[str, ...]
    truncated_name: bool
    current_category: str

    def as_prompt_item(self) -> dict[str, Any]:
        """The evidence, as the model sees it.

        Sample descriptions are included because a decision has to be grounded
        in what the bank actually printed — but never alone, and never as the
        only thing offered. They sit beside the evidence, not instead of it.
        """
        item: dict[str, Any] = {
            "counterparty_id": self.key,
            "counterparty_name": self.display,
            "name_is_truncated_by_bank": self.truncated_name,
            "evidence": {
                "transactions": self.occurrences,
                "months_spanned": self.months_spanned,
                "direction": self.direction,
                "total_amount": str(self.total),
                "median_amount": str(self.median),
                "amount_range": f"{self.smallest} to {self.largest}",
                "relationship": self.relationship,
                "relationship_strength": self.relationship_strength,
            },
            "sample_descriptions": list(self.sample_descriptions),
            "current_classification": self.current_category,
        }
        if self.merchant_type:
            item["entity_type"] = self.merchant_type
        if self.permitted_treatments:
            item["permitted_treatments"] = list(self.permitted_treatments)
        return item


INSTRUCTIONS = (
    "You are classifying COUNTERPARTIES on a South African business bank statement, not individual "
    "transactions. Each item is one counterparty with everything the statement proves about it. Your "
    "answer applies to every transaction with that counterparty, so reason from the pattern rather than "
    "from any single row.\n"
    "Decide from the evidence given. A name alone is not evidence: if the recurrence, direction, amount "
    "profile and period do not support a treatment, say so and mark it for review rather than guessing "
    "from what the name sounds like.\n"
    "Where permitted_treatments is present you MUST choose from that list or return null. It is the set "
    "of treatments this kind of entity can legitimately have, and anything outside it will be discarded.\n"
    "Direction constrains but never decides. Money received is not automatically revenue — it may be a "
    "refund, a reversal, a loan drawdown, or a transfer between the holder's own accounts. Money paid is "
    "not automatically an expense — it may be stock, an asset, a loan repayment or drawings.\n"
    "A truncated name is a prefix the bank cut short, not a complete name. Do not infer a brand from it.\n"
    "You are NOT deciding VAT. Do not state whether input VAT may be claimed, whether a tax invoice "
    "exists, or whether the supplier is VAT registered. None of that is visible on a bank statement.\n"
    "Return strict JSON only."
)

RESPONSE_SCHEMA = {
    "counterparties": [
        {
            "counterparty_id": "string, exactly as given",
            "category": "string from permitted_treatments where present, from the canonical vocabulary otherwise, or null if the evidence does not support one",
            "entity_type": "string or null — what kind of business this appears to be",
            "confidence": 0.0,
            "reason": "string — the evidence that decided it, not a restatement of the name",
            "evidence_used": ["string"],
            "review_required": True,
        }
    ]
}


def build_prompt(questions: Sequence[CounterpartyQuestion], vocabulary: Sequence[str]) -> dict[str, Any]:
    """The prompt for one batch. Global part identical for every workspace."""
    return {
        "instructions": INSTRUCTIONS,
        "canonical_categories": list(vocabulary),
        "schema": RESPONSE_SCHEMA,
        "counterparties": [question.as_prompt_item() for question in questions],
    }


def _decimal(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return abs(Decimal(str(value)))


def build_questions(
    groups: dict[str, list[Any]],
    evidence_by_key: dict[str, Any],
    *,
    merchant_type_by_key: dict[str, str] | None = None,
    min_occurrences: int = MIN_OCCURRENCES_FOR_GROUP,
) -> list[CounterpartyQuestion]:
    """Turn counterparty groups into answerable questions.

    Only groups worth asking about: a counterparty seen once carries no more
    evidence than its row did, so it stays with the row-by-row path rather than
    being dressed up as a pattern.
    """
    merchant_type_by_key = merchant_type_by_key or {}
    questions: list[CounterpartyQuestion] = []

    for key, rows in groups.items():
        evidence = evidence_by_key.get(key)
        if evidence is None or evidence.occurrences < min_occurrences:
            continue

        amounts = sorted(
            _decimal(getattr(r, "debit_amount", None) or getattr(r, "credit_amount", None))
            for r in rows
        )
        amounts = [a for a in amounts if a > 0] or [Decimal("0")]
        merchant_type = merchant_type_by_key.get(key)
        permitted: tuple[str, ...] = ()
        if merchant_type:
            spec = type_treatments().get(merchant_type) or {}
            permitted = tuple(spec.get("possible_treatments", ()))

        direction = "outbound only" if evidence.credit_count == 0 else (
            "inbound only" if evidence.debit_count == 0 else "both directions"
        )
        questions.append(
            CounterpartyQuestion(
                key=key,
                display=evidence.display,
                occurrences=evidence.occurrences,
                months_spanned=evidence.months_spanned,
                direction=direction,
                total=evidence.total_debit + evidence.total_credit,
                median=evidence.median_amount,
                smallest=amounts[0],
                largest=amounts[-1],
                relationship=getattr(evidence, "relationship", "") or "",
                relationship_strength=getattr(evidence, "relationship_strength", "") or "",
                merchant_type=merchant_type,
                permitted_treatments=permitted,
                sample_descriptions=tuple(
                    str(getattr(r, "description", ""))[:120] for r in rows[:3]
                ),
                truncated_name=bool(evidence.truncated_name),
                current_category=str(getattr(rows[0], "account_category", "") or ""),
            )
        )
    return questions


@dataclass(frozen=True)
class CounterpartyVerdict:
    """A validated answer. Anything that failed validation never becomes one."""

    key: str
    category: str | None
    entity_type: str | None
    confidence: float
    reason: str
    evidence_used: tuple[str, ...]
    review_required: bool


def validate_answers(
    raw: Any,
    questions: Sequence[CounterpartyQuestion],
    *,
    vocabulary: Iterable[str],
) -> tuple[list[CounterpartyVerdict], dict[str, int]]:
    """Check every answer against the evidence it was given.

    The prompt asks the model to stay inside the permitted treatments; this is
    what makes it true. A model that returns a category outside the vocabulary,
    outside the entity type's permitted list, or for a counterparty that was
    never sent, is not corrected — the answer is discarded and counted, because
    a wrong answer quietly repaired is a wrong answer nobody will notice.
    """
    known = {q.key: q for q in questions}
    allowed_vocabulary = set(vocabulary)
    rejected = {
        "unknown_counterparty": 0,
        "out_of_vocabulary": 0,
        "outside_permitted_treatments": 0,
        "no_reason_given": 0,
        "malformed": 0,
    }
    verdicts: list[CounterpartyVerdict] = []

    items = raw.get("counterparties") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        rejected["malformed"] += 1
        return verdicts, rejected

    for item in items:
        if not isinstance(item, dict):
            rejected["malformed"] += 1
            continue
        key = str(item.get("counterparty_id") or "")
        question = known.get(key)
        if question is None:
            # An answer about something we never asked about cannot be checked
            # against evidence, so it cannot be trusted.
            rejected["unknown_counterparty"] += 1
            continue

        # A category the model invented has to be COUNTED, not merely ignored.
        # canonicalise_category returns None for anything it does not recognise,
        # so checking the canonical form alone would let "Crypto Mining Rig"
        # vanish silently — indistinguishable from the model correctly declining
        # to answer, and exactly the kind of quiet discard that hides a problem.
        offered = item.get("category")
        offered_text = str(offered).strip() if offered else ""
        category = canonicalise_category(offered_text) if offered_text else None
        if offered_text and category is None:
            rejected["out_of_vocabulary"] += 1
        elif category is not None and category not in allowed_vocabulary:
            rejected["out_of_vocabulary"] += 1
            category = None
        if category is not None and question.permitted_treatments and category not in question.permitted_treatments:
            rejected["outside_permitted_treatments"] += 1
            category = None

        reason = str(item.get("reason") or "").strip()
        if category is not None and not reason:
            # A decision with no reason cannot be reviewed, and an unreviewable
            # decision is not an improvement on an unresolved row.
            rejected["no_reason_given"] += 1
            category = None

        try:
            confidence = float(item.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(confidence * 100 if confidence <= 1 else confidence, 100.0))

        evidence_used = item.get("evidence_used")
        evidence_used = tuple(str(e)[:160] for e in evidence_used) if isinstance(evidence_used, list) else ()

        verdicts.append(
            CounterpartyVerdict(
                key=key,
                category=category,
                entity_type=str(item.get("entity_type") or "") or None,
                confidence=confidence,
                reason=reason[:400],
                evidence_used=evidence_used,
                # An AI decision is never settled. It is a proposal a human can
                # accept, and accepting it is what makes it a learned rule.
                review_required=True,
            )
        )
    return verdicts, rejected
