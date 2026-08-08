"""How much of a statement the system actually decided, and how well.

The objective this measures is easy to state and easy to lose: maximum CORRECT
accounting automation, with a human reviewing exceptions rather than classifying
hundreds of ordinary transactions.

Both halves matter, and a single number hides one of them. A system that sends
everything to review scores perfectly on safety and is useless. A system that
books every unknown credit to revenue scores perfectly on coverage and is
dangerous. So this reports coverage BY EVIDENCE GRADE — how much was settled,
and on the strength of what — rather than one automation percentage.

It is a measuring instrument, not a decision maker: nothing here changes a
classification. It exists so that a change to the reasoning layers can be judged
against the thing it was meant to improve, instead of against a hunch.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Iterable

from engine.classification import (
    SOURCE_AI,
    SOURCE_DETERMINISTIC,
    SOURCE_LEARNED_RULE,
    SOURCE_MANUAL,
    SOURCE_UNRESOLVED,
    STRENGTH_HARD,
    STRENGTH_LEARNED,
    STRENGTH_NONE,
    STRENGTH_SOFT,
)

SETTLED_STRENGTHS = frozenset({STRENGTH_HARD, STRENGTH_LEARNED})


@dataclass(frozen=True)
class Coverage:
    """What a run decided, and on what evidence."""

    total: int
    automated: int
    """Rows some layer classified — not necessarily settled."""
    settled: int
    """Rows nothing further should revisit: bank-named fees, human decisions."""
    revisable: int
    """Classified, but a model or a reviewer could still improve it."""
    unresolved: int
    """No layer had anything to say. Honest, and the target of the next PR."""
    by_source: dict[str, int] = field(default_factory=dict)
    by_strength: dict[str, int] = field(default_factory=dict)
    by_category: dict[str, int] = field(default_factory=dict)
    value_automated: Decimal = Decimal("0")
    value_unresolved: Decimal = Decimal("0")

    @property
    def automated_pct(self) -> float:
        return round(100.0 * self.automated / self.total, 1) if self.total else 0.0

    @property
    def review_pct(self) -> float:
        return round(100.0 * self.unresolved / self.total, 1) if self.total else 0.0

    @property
    def settled_pct(self) -> float:
        return round(100.0 * self.settled / self.total, 1) if self.total else 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "automated": self.automated,
            "automated_pct": self.automated_pct,
            "settled": self.settled,
            "settled_pct": self.settled_pct,
            "revisable": self.revisable,
            "unresolved": self.unresolved,
            "review_pct": self.review_pct,
            "by_source": dict(self.by_source),
            "by_strength": dict(self.by_strength),
            "value_automated": str(self.value_automated),
            "value_unresolved": str(self.value_unresolved),
        }


def _get(row: Any, name: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        return row.get(name, default)
    return getattr(row, name, default)


def _amount(row: Any) -> Decimal:
    for name in ("debit_amount", "credit_amount"):
        value = _get(row, name)
        if value:
            return abs(Decimal(str(value)))
    return Decimal("0")


def measure(transactions: Iterable[Any]) -> Coverage:
    """Coverage for one run. Counts only; changes nothing."""
    rows = list(transactions)
    by_source: dict[str, int] = {}
    by_strength: dict[str, int] = {}
    by_category: dict[str, int] = {}
    automated = settled = revisable = unresolved = 0
    value_automated = value_unresolved = Decimal("0")

    for row in rows:
        source = str(_get(row, "classification_source") or SOURCE_UNRESOLVED)
        strength = str(_get(row, "classification_strength") or STRENGTH_NONE)
        category = str(_get(row, "account_category") or "Uncategorised")
        by_source[source] = by_source.get(source, 0) + 1
        by_strength[strength] = by_strength.get(strength, 0) + 1
        by_category[category] = by_category.get(category, 0) + 1

        amount = _amount(row)
        if source == SOURCE_UNRESOLVED:
            unresolved += 1
            value_unresolved += amount
            continue

        automated += 1
        value_automated += amount
        if strength in SETTLED_STRENGTHS:
            settled += 1
        else:
            revisable += 1

    return Coverage(
        total=len(rows),
        automated=automated,
        settled=settled,
        revisable=revisable,
        unresolved=unresolved,
        by_source=by_source,
        by_strength=by_strength,
        by_category=by_category,
        value_automated=value_automated,
        value_unresolved=value_unresolved,
    )


def compare(before: Coverage, after: Coverage) -> dict[str, Any]:
    """What a change did to coverage.

    `regressed` is the question that matters, and it is deliberately strict:
    automation going DOWN is a regression even if every remaining decision got
    better, because the objective is not to reduce risk by sending more work to
    a human. Improving a row's reasoning while keeping it automated is progress;
    moving it to review is not.
    """
    return {
        "automated_before": before.automated,
        "automated_after": after.automated,
        "automated_delta": after.automated - before.automated,
        "unresolved_before": before.unresolved,
        "unresolved_after": after.unresolved,
        "settled_before": before.settled,
        "settled_after": after.settled,
        "automated_pct_before": before.automated_pct,
        "automated_pct_after": after.automated_pct,
        "regressed": after.automated < before.automated,
    }
