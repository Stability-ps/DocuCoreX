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

from main import ParsedTransaction, build_workbook, validate_statement, validation_summary


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



def run() -> None:
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
