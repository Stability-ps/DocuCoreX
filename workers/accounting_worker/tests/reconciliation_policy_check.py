"""Reconciliation policy: a difference of exactly 0 reconciles, R0.01-R0.05
needs review, more fails. A nonzero difference never passes as reconciled.
Mirrors lib/accounting/reconciliation-policy.ts.

Run by run_regression.sh.
"""
from decimal import Decimal
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import ParsedTransaction, reconciliation_status, validate_extraction  # noqa: E402

for difference, expected in [
    ("0.00", "reconciled"), ("0.01", "needs_review"), ("-0.01", "needs_review"), ("0.05", "needs_review"),
    ("-0.05", "needs_review"), ("0.06", "failed"), ("-0.06", "failed"), ("-12345.67", "failed"), ("0.004", "reconciled"),
]:
    got = reconciliation_status(Decimal(difference))
    assert got == expected, f"{difference}: expected {expected}, got {got}"
assert reconciliation_status(None) is None

fixture = json.loads((Path(__file__).parent / "fixtures" / "synthetic-balanced-baseline.json").read_text())
transactions = [ParsedTransaction(**row) for row in fixture["transactions"]]
base = validate_extraction(dict(fixture["metadata"]), transactions)
assert base["reconciliation_status"] == "reconciled", base["reconciliation_status"]
closing = Decimal(str(fixture["metadata"]["closing_balance"]))

for offset, expected in [(Decimal("0.03"), "needs_review"), (Decimal("-0.05"), "needs_review"), (Decimal("0.06"), "failed")]:
    metadata = dict(fixture["metadata"], closing_balance=float(closing + offset))
    report = validate_extraction(metadata, transactions)
    assert report["reconciliation_status"] == expected, (offset, report["reconciliation_status"])
    assert report["status"] == "review_required", f"closing off by {offset} must not report ok"
    assert "reconciliation" in report["failures"], report["failures"]

print("reconciliation policy: exact 0 reconciled, R0.01-R0.05 needs review, larger differences fail")
