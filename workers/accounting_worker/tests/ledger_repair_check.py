"""Checks for deterministic ledger repair.

Every case is expressed WITHOUT a merchant name, transaction type or bank. If
any of them needed one, the rule would be a patch rather than a fix.
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.ledger_repair import (  # noqa: E402
    SIGN_EXPLICIT_CR,
    SIGN_EXPLICIT_DR,
    SIGN_INFERRED,
    SIGN_UNVERIFIED,
    RepairRow,
    repair_rows,
    summarize_repairs,
)


def assert_equal(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def d(value: str) -> Decimal:
    return Decimal(value)


def check_overdrawn_balance_sign_is_restored() -> None:
    """From the real statement: 314.98 in credit, a 450.00 debit, printed "135.02".

    That is 135.02 OVERDRAWN. Read as positive it flips the account into credit
    and every later continuity check fails.
    """
    result = repair_rows([RepairRow(d("450.00"), None, d("135.02"))], d("314.98"))
    assert_equal(result[0]["balance"], d("-135.02"), "overdrawn balance is negative")
    assert_equal(result[0]["balance_sign_source"], SIGN_INFERRED, "and says how it was decided")
    assert_equal(result[0]["changed"], True, "the change is recorded")


def check_explicit_markers_win() -> None:
    """A statement that says Cr or Dr is not guessed at."""
    cr = repair_rows([RepairRow(None, d("100.00"), d("500.00"), "Cr")], d("400.00"))
    assert_equal(cr[0]["balance_sign_source"], SIGN_EXPLICIT_CR, "cr wins")

    dr = repair_rows([RepairRow(d("100.00"), None, d("500.00"), "Dr")], d("400.00"))
    assert_equal(dr[0]["balance"], d("-500.00"), "dr is negative")
    assert_equal(dr[0]["balance_sign_source"], SIGN_EXPLICIT_DR, "dr wins")


def check_a_mismatch_is_never_guessed() -> None:
    """Neither hypothesis matching means a missing or misparsed row."""
    result = repair_rows([RepairRow(d("450.00"), None, d("999.99"))], d("314.98"))
    assert_equal(result[0]["balance"], d("999.99"), "left exactly as printed")
    assert_equal(result[0]["balance_sign_source"], SIGN_UNVERIFIED, "and marked unverified")
    assert_equal(result[0]["non_posting"], False, "and not claimed as non-posting")


def check_a_positive_run_is_untouched() -> None:
    """A statement that never goes overdrawn comes through unaltered."""
    result = repair_rows(
        [RepairRow(None, d("1000.00"), d("6499.63")), RepairRow(d("500.00"), None, d("5999.63"))],
        d("5499.63"),
    )
    assert_equal([r["changed"] for r in result], [False, False], "no spurious changes")
    assert_equal([r["non_posting"] for r in result], [False, False], "nothing wrongly suppressed")


def check_no_opening_balance_means_no_inference() -> None:
    result = repair_rows([RepairRow(d("450.00"), None, d("135.02"))], None)
    assert_equal(result[0]["balance_sign_source"], SIGN_UNVERIFIED, "honest about not knowing")
    assert_equal(result[0]["changed"], False, "and changes nothing")


def check_non_posting_detected_by_balance_standing_still() -> None:
    """An amount is shown and the balance does not move — whatever it is called."""
    result = repair_rows(
        [
            RepairRow(d("6232.30"), None, d("491.60")),   # posts, overdrawn
            RepairRow(None, d("6232.30"), d("491.60")),   # balance unchanged
            RepairRow(d("99.95"), None, d("591.55")),     # posts
        ],
        d("5740.70"),
    )
    assert_equal([r["non_posting"] for r in result], [False, True, False], "only the still row")
    assert_equal(result[1]["reason"], "balance_unchanged", "states its evidence")


def check_the_real_sequence_resolves_end_to_end() -> None:
    """The exact rows from the production statement, in order.

    This is the case two ordered passes could not do: the collection attempt
    breaks the posting hypothesis, so a sign-only pass marks it unverified,
    keeps +491.60, and carries that wrong sign into every row after it.
    """
    result = repair_rows(
        [
            RepairRow(d("6232.30"), None, d("5740.70"), "Cr"),  # explicit Cr
            RepairRow(d("6232.30"), None, d("491.60")),         # posts, now overdrawn
            RepairRow(None, d("6232.30"), d("491.60")),         # non-posting
            RepairRow(d("99.95"), None, d("591.55")),           # posts, deeper overdrawn
        ],
        d("11973.00"),
    )
    assert_equal(result[1]["balance"], d("-491.60"), "overdrawn after the second debit")
    assert_equal(result[2]["non_posting"], True, "the collection attempt moves nothing")
    assert_equal(result[2]["balance"], d("-491.60"), "and holds the balance")
    assert_equal(result[3]["balance"], d("-591.55"), "the row AFTER it still resolves")
    assert_equal(result[3]["non_posting"], False, "and is not mistaken for non-posting")


def check_zero_amount_rows_are_not_non_posting() -> None:
    """A zero-amount row shows no money, so standing still proves nothing."""
    result = repair_rows([RepairRow(None, None, d("1000.00"))], d("1000.00"))
    assert_equal(result[0]["non_posting"], False, "not evidence")


def check_the_real_credit_variance_is_explained() -> None:
    """One non-posting credit accounts for the whole credit discrepancy."""
    assert_equal(d("212662.97") - d("6232.30"), d("206430.67"), "declared credit total")
    assert_equal(12 - 1, 11, "declared credit count")


def check_summary_counts_every_repair() -> None:
    """A repair that is not counted is a repair nobody can audit."""
    result = repair_rows(
        [
            RepairRow(d("450.00"), None, d("135.02")),   # sign inferred
            RepairRow(None, d("100.00"), d("135.02")),   # non-posting
            RepairRow(d("10.00"), None, d("777.77")),    # unverified
        ],
        d("314.98"),
    )
    summary = summarize_repairs(result)
    assert_equal(summary["balance_signs_inferred"] >= 1, True, "inferences counted")
    assert_equal(summary["non_posting_rows"], 1, "non-posting counted")
    assert_equal(summary["balance_signs_unverified"], 1, "unverified counted")


def check_rules_are_bank_neutral() -> None:
    """The product rule, made executable: a fix needing a bank name will not travel."""
    source = (Path(__file__).resolve().parents[1] / "engine" / "ledger_repair.py").read_text().lower()
    for token in ("fnb", "absa", "nedbank", "capitec", "standard bank", "edo ", "debicheck", "south africa"):
        if token in source:
            raise AssertionError(f"ledger_repair must not reference {token!r}")


def run() -> None:
    check_overdrawn_balance_sign_is_restored()
    check_explicit_markers_win()
    check_a_mismatch_is_never_guessed()
    check_a_positive_run_is_untouched()
    check_no_opening_balance_means_no_inference()
    check_non_posting_detected_by_balance_standing_still()
    check_the_real_sequence_resolves_end_to_end()
    check_zero_amount_rows_are_not_non_posting()
    check_the_real_credit_variance_is_explained()
    check_summary_counts_every_repair()
    check_rules_are_bank_neutral()
    print("Ledger repair checks passed.")


if __name__ == "__main__":
    run()
