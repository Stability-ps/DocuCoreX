"""Deterministic ledger repair from running-balance continuity.

Two defects that look bank-specific are not. Both are properties of how banks
print a running balance, and both are decidable from arithmetic alone — no
merchant string, no institution name, no country.

    1. A printed balance whose SIGN is lost. Many banks mark a credit balance
       with a suffix ("Cr") and print an overdrawn balance as a bare magnitude.
       Reading the magnitude as positive silently flips the account from
       overdrawn to in-credit, and every subsequent continuity check fails.

    2. A row that shows an amount while the balance DOES NOT MOVE. Collection
       attempts, reversals shown for information, authorisation holds and
       declined instructions all print like transactions and move no money. The
       bank's own declared counts exclude them.

The rule for both is the same and is stated once:

    expected = previous_balance + credit - debit

If the printed magnitude equals |expected| but the sign differs, the sign was
lost in extraction and can be restored. If the balance does not move at all
while an amount is shown, no money moved and the row is informational.

Deliberately NOT here:
  - any list of descriptions, merchants or transaction types
  - any bank or country conditional
  - any adjustment that makes a statement reconcile without evidence

Nothing in this module invents a row, deletes source evidence, or changes an
amount. It restores a sign that extraction dropped, and it marks rows the
statement itself shows as non-posting. Every decision records how it was made.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable, Sequence

CENT = Decimal("0.01")
#: Rounding tolerance. Tight on purpose: a genuine missing transaction must not
#: be absorbed as a rounding artefact.
TOLERANCE = Decimal("0.05")

#: How a row's balance sign was established.
SIGN_EXPLICIT_CR = "explicit_cr"
SIGN_EXPLICIT_DR = "explicit_dr"
SIGN_INFERRED = "inferred_from_continuity"
SIGN_UNVERIFIED = "unverified"


@dataclass
class RepairRow:
    """The minimum a repair needs. Deliberately not the full transaction type,
    so this module stays testable without the worker's model."""

    debit: Decimal | None
    credit: Decimal | None
    balance: Decimal | None
    #: "cr" / "dr" when the statement printed one, else None.
    balance_suffix: str | None = None


def _amount(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    return Decimal(str(value)).quantize(CENT)


def infer_balance_signs(
    rows: Sequence[RepairRow],
    opening_balance: Decimal | float | str | None,
) -> list[dict[str, Any]]:
    """Restore balance signs that extraction dropped.

    Walks the statement forward from its opening balance. At each row the next
    balance is arithmetically determined; where the printed magnitude agrees
    with it but the sign does not, the sign is restored and recorded as
    inferred. Where the statement printed an explicit marker, that marker wins
    and no inference is made.

    A row whose magnitude does NOT match expectation is left exactly as printed
    and marked unverified. That is the honest outcome: a mismatch means either a
    missing row or a misparse, and guessing a sign would convert a visible
    problem into an invisible one.
    """
    if opening_balance is None:
        return [
            {"balance": row.balance, "balance_sign_source": SIGN_UNVERIFIED, "changed": False}
            for row in rows
        ]

    previous = _amount(opening_balance)
    out: list[dict[str, Any]] = []

    for row in rows:
        if row.balance is None:
            out.append({"balance": None, "balance_sign_source": SIGN_UNVERIFIED, "changed": False})
            continue

        printed = _amount(row.balance)
        expected = (previous + _amount(row.credit) - _amount(row.debit)).quantize(CENT)

        suffix = (row.balance_suffix or "").lower()
        if suffix == "cr":
            resolved, source = printed.copy_abs(), SIGN_EXPLICIT_CR
        elif suffix == "dr":
            resolved, source = -printed.copy_abs(), SIGN_EXPLICIT_DR
        elif abs(printed.copy_abs() - expected.copy_abs()) <= TOLERANCE:
            # The magnitude agrees, so the statement and the arithmetic describe
            # the same number and only the sign is in question. Take it from the
            # arithmetic, which cannot be lost in extraction.
            resolved, source = expected, SIGN_INFERRED
        else:
            resolved, source = printed, SIGN_UNVERIFIED

        out.append(
            {
                "balance": resolved,
                "balance_sign_source": source,
                "changed": resolved != printed,
            }
        )
        # Continue from what the statement printed, as corrected. Using the
        # expected value instead would let one bad row silently rewrite the rest
        # of the statement.
        previous = resolved

    return out



def apply_sign_results(
    rows: Sequence[RepairRow],
    sign_results: Sequence[dict[str, Any]],
) -> list[RepairRow]:
    """Rebuild rows with their corrected balances.

    ORDER MATTERS, and getting it wrong is silent. Non-posting detection asks
    whether the balance moved, which is a question about SIGNED values: a row
    printed "135.02" after a balance of "-135.02" has not stood still, it has
    swung by 270.04. Running the detection on uncorrected balances therefore
    misses genuine non-posting rows and can invent others.

    So the sequence is always: infer signs, apply them, then detect non-posting.
    """
    return [
        RepairRow(
            debit=row.debit,
            credit=row.credit,
            balance=result["balance"],
            balance_suffix=row.balance_suffix,
        )
        for row, result in zip(rows, sign_results)
    ]


def detect_non_posting_rows(
    rows: Sequence[RepairRow],
    opening_balance: Decimal | float | str | None,
) -> list[dict[str, Any]]:
    """Identify rows that show an amount while moving no money.

    The evidence is the balance standing still. A row carrying a non-zero amount
    whose balance equals the balance before it did not move money, whatever it
    is called — a collection attempt, a reversal shown for information, a hold,
    a declined instruction. Banks in different countries print all of these, and
    none of them belong in a ledger total.

    Returns one verdict per row so the caller can keep the row as source
    evidence while excluding it from monetary totals. Nothing is deleted here.
    """
    verdicts: list[dict[str, Any]] = []
    previous = _amount(opening_balance) if opening_balance is not None else None

    for row in rows:
        amount = _amount(row.credit) - _amount(row.debit)
        if row.balance is None or previous is None or amount == 0:
            verdicts.append({"non_posting": False, "reason": None})
            if row.balance is not None:
                previous = _amount(row.balance)
            continue

        current = _amount(row.balance)
        if abs(current - previous) <= TOLERANCE:
            # An amount was shown and the balance did not move.
            verdicts.append(
                {
                    "non_posting": True,
                    "reason": "balance_unchanged",
                    "amount": str(amount.copy_abs()),
                    "balance": str(current),
                }
            )
            # previous is unchanged — a non-posting row moves nothing, so the
            # next row must be measured from the same balance.
            continue

        verdicts.append({"non_posting": False, "reason": None})
        previous = current

    return verdicts



def repair_rows(
    rows: Sequence[RepairRow],
    opening_balance: Decimal | float | str | None,
) -> list[dict[str, Any]]:
    """Resolve balance sign and posting status together, in one forward pass.

    These cannot be decided separately, and discovering why is the substance of
    this module.

    Sign inference assumes every row posts: it predicts
    `previous + credit - debit` and matches the printed magnitude against it.
    A non-posting row violates that assumption by construction — its balance
    equals the PREVIOUS balance, not the predicted one. Run as two passes, sign
    inference meets such a row, fails to match, marks it unverified, leaves its
    sign wrong, and then carries that wrong balance forward, corrupting every
    row after it. On the real statement that is exactly what happened at the
    6,232.30 collection attempt.

    So each row is tested against BOTH hypotheses:

        posts       →  |printed| == |previous + credit - debit|
        non-posting →  |printed| == |previous|

    Whichever the statement's own arithmetic supports is adopted, and the
    balance carried forward is the resolved one. When neither matches, nothing
    is decided: the row keeps exactly what was printed and is marked unverified,
    because a mismatch means a missing or misparsed row and guessing would hide
    it.

    Non-posting is tested FIRST only where both would match — that is, where the
    amount is zero and the two hypotheses coincide — and in that case the row
    moves no money either way, so the distinction is immaterial.
    """
    if opening_balance is None:
        return [
            {
                "balance": row.balance,
                "balance_sign_source": SIGN_UNVERIFIED,
                "non_posting": False,
                "reason": "no_opening_balance",
                "changed": False,
            }
            for row in rows
        ]

    previous = _amount(opening_balance)
    out: list[dict[str, Any]] = []

    for row in rows:
        if row.balance is None:
            out.append(
                {
                    "balance": None,
                    "balance_sign_source": SIGN_UNVERIFIED,
                    "non_posting": False,
                    "reason": "no_printed_balance",
                    "changed": False,
                }
            )
            continue

        printed = _amount(row.balance)
        amount = _amount(row.credit) - _amount(row.debit)
        expected = (previous + amount).quantize(CENT)
        suffix = (row.balance_suffix or "").lower()

        posts_matches = abs(printed.copy_abs() - expected.copy_abs()) <= TOLERANCE
        still_matches = amount != 0 and abs(printed.copy_abs() - previous.copy_abs()) <= TOLERANCE

        if suffix == "cr":
            resolved, source = printed.copy_abs(), SIGN_EXPLICIT_CR
            non_posting = amount != 0 and abs(resolved - previous) <= TOLERANCE
        elif suffix == "dr":
            resolved, source = -printed.copy_abs(), SIGN_EXPLICIT_DR
            non_posting = amount != 0 and abs(resolved - previous) <= TOLERANCE
        elif posts_matches:
            resolved, source, non_posting = expected, SIGN_INFERRED, False
        elif still_matches:
            # The balance did not move while an amount was shown. Its sign is
            # the sign it already had.
            resolved, source, non_posting = previous, SIGN_INFERRED, True
        else:
            resolved, source, non_posting = printed, SIGN_UNVERIFIED, False

        out.append(
            {
                "balance": resolved,
                "balance_sign_source": source,
                "non_posting": non_posting,
                "reason": "balance_unchanged" if non_posting else None,
                "changed": resolved != printed,
            }
        )
        previous = resolved

    return out


def summarize_repairs(results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Counts for logging, so a repair is never silent."""
    rows = list(results)
    return {
        "balance_signs_inferred": sum(1 for r in rows if r["balance_sign_source"] == SIGN_INFERRED),
        "balance_signs_unverified": sum(1 for r in rows if r["balance_sign_source"] == SIGN_UNVERIFIED),
        "non_posting_rows": sum(1 for r in rows if r["non_posting"]),
    }
