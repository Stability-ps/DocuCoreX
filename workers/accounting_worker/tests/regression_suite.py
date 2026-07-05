from __future__ import annotations

import importlib.util
import io
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if importlib.util.find_spec("fitz") is None:
    sys.modules["fitz"] = types.ModuleType("fitz")

if importlib.util.find_spec("pdfplumber") is None:
    sys.modules["pdfplumber"] = types.ModuleType("pdfplumber")

if importlib.util.find_spec("fastapi") is None:
    fastapi = types.ModuleType("fastapi")

    class FastAPI:
        def __init__(self, *args, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda func: func

        def post(self, *args, **kwargs):
            return lambda func: func

        def exception_handler(self, *args, **kwargs):
            return lambda func: func

    class HTTPException(Exception):
        def __init__(self, status_code=500, detail=None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    def Header(default=None, *args, **kwargs):
        return default

    fastapi.FastAPI = FastAPI
    fastapi.Header = Header
    fastapi.HTTPException = HTTPException
    fastapi.Request = object
    sys.modules["fastapi"] = fastapi

    fastapi_exceptions = types.ModuleType("fastapi.exceptions")
    fastapi_exceptions.RequestValidationError = Exception
    sys.modules["fastapi.exceptions"] = fastapi_exceptions

    fastapi_responses = types.ModuleType("fastapi.responses")
    fastapi_responses.JSONResponse = dict
    fastapi_responses.Response = dict
    sys.modules["fastapi.responses"] = fastapi_responses

if importlib.util.find_spec("pydantic") is None:
    pydantic = types.ModuleType("pydantic")

    class BaseModel:
        def __init__(self, **kwargs):
            for cls in reversed(self.__class__.mro()):
                for key, value in getattr(cls, "__dict__", {}).items():
                    if not key.startswith("_") and key not in {"model_dump"} and not callable(value):
                        setattr(self, key, value)
            for key, value in kwargs.items():
                setattr(self, key, value)

        def model_dump(self, *args, **kwargs):
            return dict(self.__dict__)

    pydantic.BaseModel = BaseModel
    sys.modules["pydantic"] = pydantic

if importlib.util.find_spec("supabase") is None:
    supabase = types.ModuleType("supabase")
    supabase.Client = object

    def create_client(*args, **kwargs):
        return object()

    supabase.create_client = create_client
    sys.modules["supabase"] = supabase

if importlib.util.find_spec("openpyxl") is None:
    raise RuntimeError(
        "openpyxl is required for regression workbook verification. Install worker deps before running regression suite."
    )

from openpyxl import load_workbook

from main import (
    ParsedTransaction,
    build_workbook,
    parse_transactions,
    validate_statement,
    validation_summary,
)


ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = ROOT / "workers" / "accounting_worker" / "tests" / "fixtures" / "regression_manifest.json"


def assert_equal(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def run_synthetic_case(case_id: str, fixture_path: Path) -> None:
    fixture = json.loads(fixture_path.read_text())
    metadata = fixture["metadata"]
    transactions = [ParsedTransaction(**row) for row in fixture["transactions"]]
    expected = fixture["expected"]

    validation = validate_statement(metadata, transactions)
    summary = validation_summary(transactions)

    assert_equal(str(validation["opening_balance"]), expected["opening_balance"], f"{case_id} opening balance")
    assert_equal(str(validation["closing_balance"]), expected["closing_balance"], f"{case_id} closing balance")
    assert_equal(str(summary["total_credits"]), expected["total_credits"], f"{case_id} total credits")
    assert_equal(str(summary["total_debits"]), expected["total_debits"], f"{case_id} total debits")
    assert_equal(validation["transaction_count"], expected["transaction_count"], f"{case_id} transaction count")
    assert_equal(
        str(validation["calculated_closing"]),
        str(validation["closing_balance"]),
        f"{case_id} reconciliation",
    )

    workbook_bytes = build_workbook(metadata, transactions)
    workbook = load_workbook(io.BytesIO(workbook_bytes), data_only=True)
    for sheet_name in expected["workbook_required_sheets"]:
        if sheet_name not in workbook.sheetnames:
            raise AssertionError(f"{case_id} missing required sheet: {sheet_name}")

    vat_sheet = workbook["VAT Schedule"]
    if vat_sheet.max_row < 2:
        raise AssertionError(f"{case_id} VAT extraction failed: expected transaction rows in VAT Schedule")

    tx_sheet = workbook["Transactions"]
    for row_index in range(2, tx_sheet.max_row + 1):
        account = tx_sheet.cell(row=row_index, column=11).value
        if not account:
            raise AssertionError(f"{case_id} AI/account categorisation missing at transaction row {row_index}")

    ai_diagnostics = metadata.get("_ai_diagnostics")
    if not isinstance(ai_diagnostics, dict):
        raise AssertionError(f"{case_id} AI diagnostics missing from workbook metadata")
    required_ai_keys = {
        "ai_enabled",
        "ai_model",
        "ai_transactions_sent",
        "ai_transactions_classified",
        "ai_failures",
        "ai_cache_hits",
        "ai_classification_duration_ms",
    }
    if not required_ai_keys.issubset(ai_diagnostics.keys()):
        missing = sorted(required_ai_keys.difference(ai_diagnostics.keys()))
        raise AssertionError(f"{case_id} AI diagnostics missing keys: {missing}")



# ── FNB date-grouped extraction regression (ACAPOLITE class of failure) ──────
#
# FNB prints a transaction date only once per date group; later rows in the
# group (debit orders, app / RTC payments, fee lines) print WITHOUT a leading
# date. Those rows were being merged into the previous line and dropped, so the
# statement lost 6 debits (R29,912.54) and failed to reconcile. This fixture
# reproduces that exact layout at full scale (143 transactions) and fails unless
# every row is extracted and the reconciliation difference is R0.00.
FNB_EXPECTED = {
    "transaction_count": 143,
    "credit_count": 15,
    "debit_count": 128,
    "total_credits": "419700.00",
    "total_debits": "422747.72",
    "opening_balance": "3390.09",
    "closing_balance": "342.37",
}


def _build_acapolite_style_statement() -> tuple[str, dict]:
    from decimal import Decimal as D

    lines = ["Transactions in Rand (ZAR)"]
    bal = D("3390.09")  # true running balance for the balance-bearing rows

    def money(value: D) -> str:
        return f"{value:,.2f}"

    # 15 credits summing 419,700.00.
    for i in range(15):
        bal += D("27980.00")
        lines.append(f"0{(i % 9) + 1} Mar Eft Deposit Customer {i:03d} 27,980.00Cr {money(bal)} Cr")

    # 121 ordinary debits of 3,200.00 (each date-led with a running balance).
    for i in range(121):
        bal -= D("3200.00")
        lines.append(f"1{(i % 9)} Mar Card Purchase Merchant {i:03d} 3,200.00 {money(bal)} Cr")
    # One more ordinary debit (5,635.18) immediately followed by the date-LESS
    # debit-order row (the ACAPOLITE 02 Mar case) that used to be swallowed.
    bal -= D("5635.18")
    lines.append(f"02 Mar Card Purchase Fuel Filling Station 5,635.18 {money(bal)} Cr")
    lines.append("Internal Debit Order Fnbfuneral Fi11941792 J62730 696.30")

    # 18 Mar group: date printed once, second payment has no leading date.
    lines.append("18 Mar Fnb App Payment To 819035690 3,000.00")
    lines.append("Fnb App Rtc Pmt To Patric 25,000.00")

    # 24 Mar fee group: three fee rows, date printed once.
    lines.append("24 Mar Monthly Account Fee 93.00")
    lines.append("Service Fees 523.80")
    lines.append("Cash Deposit Fee 599.44")

    lines.append("Closing Balance 342.37")

    metadata = {
        "statement_period_start": "2026-03-01",
        "statement_period_end": "2026-03-31",
        "opening_balance": 3390.09,
        "closing_balance": 342.37,
    }
    return "\n".join(lines), metadata


def run_fnb_extraction_case() -> None:
    case_id = "fnb-acapolite-grouped-rows"
    text, metadata = _build_acapolite_style_statement()
    transactions = parse_transactions([], metadata, text)

    # All 143 rows must be extracted — including the 6 date-grouped debits.
    assert_equal(len(transactions), FNB_EXPECTED["transaction_count"], f"{case_id} transaction count")

    # The six previously-missing rows must be present with the exact amounts.
    missing_rows = {
        ("Internal Debit Order Fnbfuneral Fi11941792 J62730", "696.30"),
        ("Fnb App Payment To 819035690", "3000.00"),
        ("Fnb App Rtc Pmt To Patric", "25000.00"),
        ("Monthly Account Fee", "93.00"),
        ("Service Fees", "523.80"),
        ("Cash Deposit Fee", "599.44"),
    }
    extracted = {(t.description, f"{(t.debit_amount or 0):.2f}") for t in transactions}
    for desc, amount in missing_rows:
        if (desc, amount) not in extracted:
            raise AssertionError(f"{case_id}: missing row not extracted: {desc} R{amount}")

    summary = validation_summary(transactions)
    assert_equal(str(summary["total_credits"]), FNB_EXPECTED["total_credits"], f"{case_id} total credits")
    assert_equal(str(summary["total_debits"]), FNB_EXPECTED["total_debits"], f"{case_id} total debits")
    assert_equal(summary["credit_count"], FNB_EXPECTED["credit_count"], f"{case_id} credit count")
    assert_equal(summary["debit_count"], FNB_EXPECTED["debit_count"], f"{case_id} debit count")

    # Reconciliation difference must be exactly R0.00 (validate_statement raises otherwise).
    validation = validate_statement(metadata, transactions)
    if validation["calculated_closing"] != validation["closing_balance"]:
        raise AssertionError(
            f"{case_id}: reconciliation difference not zero — calculated {validation['calculated_closing']} vs closing {validation['closing_balance']}"
        )
    assert_equal(str(validation["closing_balance"]), FNB_EXPECTED["closing_balance"], f"{case_id} closing balance")


def run() -> None:
    run_fnb_extraction_case()

    manifest = json.loads(MANIFEST_PATH.read_text())
    cases = manifest.get("cases") if isinstance(manifest, dict) else None
    if not isinstance(cases, list) or not cases:
        raise AssertionError("Regression manifest has no cases. Add at least one statement fixture.")

    for case in cases:
        case_id = str(case.get("id") or "unnamed")
        source = str(case.get("source") or "")
        fixture_rel_path = case.get("fixture")
        if source != "synthetic":
            raise AssertionError(f"{case_id}: unsupported source {source!r}")
        if not isinstance(fixture_rel_path, str) or not fixture_rel_path:
            raise AssertionError(f"{case_id}: fixture path is required")

        fixture_path = ROOT / fixture_rel_path
        if not fixture_path.exists():
            raise AssertionError(f"{case_id}: fixture file not found: {fixture_path}")

        run_synthetic_case(case_id, fixture_path)


if __name__ == "__main__":
    run()
    print("Accounting regression suite passed.")
