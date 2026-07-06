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
    parse_metadata,
    parse_transactions,
    validate_statement,
    validation_summary,
)


def run_statement_period_case() -> None:
    # ALLIANZ 31 March 2026 statement: the period end and statement date must be
    # read from the PDF so the app names it March 2026 (not the July upload date).
    case_id = "allianz-statement-period"
    text = (
        "ALLIANZ HOLDINGS (PTY) LTD\n"
        "Account Number: 63012589818\n"
        "Statement Period: 28 February 2026 to 31 March 2026\n"
        "Statement Date: 31 March 2026\n"
    )
    meta = parse_metadata(text)
    assert_equal(meta["statement_period_start"], "2026-02-28", f"{case_id} period start")
    assert_equal(meta["statement_period_end"], "2026-03-31", f"{case_id} period end")
    assert_equal(meta["statement_date"], "2026-03-31", f"{case_id} statement date")
    # Naming must come from period end (March), not the upload month.
    assert_equal(meta["statement_period_end"][:7], "2026-03", f"{case_id} names to March 2026")


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


def run_missing_column_fallback_case() -> None:
    # If the DB schema lacks an optional column (e.g. statement_date before its
    # migration is applied), the run update must drop it and still save — never
    # fail the whole processing job with HTTP 422.
    from main import update_statement_run

    case_id = "missing-statement-date-column"
    calls: list[dict] = []

    class Query:
        def __init__(self, fields, fail_on):
            self.fields = fields
            self.fail_on = fail_on

        def eq(self, *args, **kwargs):
            return self

        def execute(self):
            calls.append(self.fields)
            if self.fail_on and self.fail_on(self.fields):
                raise RuntimeError(self.fail_on(self.fields))
            return None

    def make_supabase(fail_on):
        class Table:
            def update(self, fields):
                return Query(fields, fail_on)

        class Supabase:
            def table(self, _name):
                return Table()

        return Supabase()

    schema_error = "Could not find the 'statement_date' column of 'accounting_statement_runs' in the schema cache"
    supabase = make_supabase(lambda fields: schema_error if "statement_date" in fields else None)
    update_statement_run(supabase, "run-1", "ws-1", {"statement_date": "2026-03-31", "status": "completed", "confidence": 90})
    assert_equal(len(calls), 2, f"{case_id} retried once without the optional column")
    assert_equal("statement_date" in calls[1], False, f"{case_id} dropped the missing column")
    assert_equal(calls[1]["status"], "completed", f"{case_id} core fields preserved")

    # Non-schema errors must still propagate (not silently swallowed).
    raised = False
    try:
        update_statement_run(make_supabase(lambda _fields: "permission denied"), "run-1", "ws-1", {"statement_date": "2026-03-31", "status": "completed"})
    except RuntimeError:
        raised = True
    assert_equal(raised, True, f"{case_id} non-schema errors propagate")


def run_validation_diagnostics_case() -> None:
    # When extraction does not match the statement's declared figures, validation
    # must fail with the SPECIFIC rules and extracted-vs-declared values (not a
    # generic "layout needs review"), and must never pass silently.
    from main import HTTPException, ParsedTransaction, validate_statement

    case_id = "validation-diagnostics"

    def txn(debit=None, credit=None):
        return ParsedTransaction(
            transaction_date="2026-03-10", description="x", debit_amount=debit, credit_amount=credit,
            running_balance=None, bank_charge=False, account_category="X", vat_treatment="review",
            supported_by_invoice=False, confidence=90, review_status="ready", source_page=1, raw_text="r",
        )

    # Declares 143 (15 credits / 128 debits) but only 137 extracted (6 debits missing).
    meta = {
        "opening_balance": 3390.09, "closing_balance": 342.37,
        "expected_transaction_count": 143, "expected_credit_count": 15, "expected_debit_count": 128,
        "declared_credit_total": 419700.00, "declared_debit_total": 422747.72,
    }
    txns = [txn(credit=419700.00 / 15) for _ in range(15)] + [txn(debit=392835.18 / 122) for _ in range(122)]

    raised = False
    try:
        validate_statement(meta, txns)
    except HTTPException as exc:
        raised = True
        detail = exc.detail
        for rule in ("reconciliation", "transaction_count", "debit_count", "debit_total"):
            if rule not in detail["failed_rules"]:
                raise AssertionError(f"{case_id}: expected failed rule {rule}, got {detail['failed_rules']}")
        assert_equal(detail["suspected_missing_rows"], 6, f"{case_id} suspected missing rows")
        assert_equal(detail["extracted_transaction_count"], 137, f"{case_id} extracted count")
        assert_equal(detail["expected_transaction_count"], 143, f"{case_id} expected count")
        joined = " ".join(detail["errors"])
        if "extracted 137 vs declared 143" not in joined:
            raise AssertionError(f"{case_id}: error must show extracted vs declared, got {detail['errors']}")
        # Must not hardcode a specific statement's expected figures.
        import inspect
        import main as worker_main
        if "111600.56" in inspect.getsource(worker_main.validate_statement):
            raise AssertionError(f"{case_id}: validate_statement must not hardcode a per-statement expectation")
    if not raised:
        raise AssertionError(f"{case_id}: validation must fail (not pass silently) when extraction is short")


def run_april_missing_rows_case() -> None:
    # April 2026 (ACAPOLITE) statement: three rows print an amount + running
    # balance WITHOUT a Cr/Dr suffix (two Internal Debit Order / FnbFuneral rows
    # and one "#Excess Item Fee") and were dropped, breaking reconciliation by
    # R1,682.32. The parser must now capture them and the fee must be Bank Charges.
    from decimal import Decimal as D

    from main import parse_transactions, validate_statement, validation_summary

    case_id = "april-missing-rows"
    opening, closing = D("342.37"), D("368.96")
    lines = ["Transactions in Rand (ZAR)"]
    bal = opening

    def money(value: D) -> str:
        return f"{value:,.2f}"

    def balance_cell(value: D) -> str:
        # FNB prints Cr for a positive balance; overdrawn balances print without
        # "Cr" (magnitude only) — exactly the case the parser must handle.
        return f"{money(value)} Cr" if value >= 0 else money(value.copy_abs())

    # 3 rows FIRST, pushing the account overdrawn, with amount + balance and NO
    # Cr/Dr suffix on the (negative) balance — the previously-dropped rows.
    specials = [
        ("01 Apr Internal Debit Order Fnbfuneral Fi11941792A Ex6460", D("676.02")),
        ("01 Apr Internal Debit Order Fnbfuneral Fi11941792 Ex6462", D("696.30")),
        ("02 Apr #Excess Item Fee 2 Items On 26/04/01", D("310.00")),
    ]
    for desc, amt in specials:
        bal -= amt  # now negative
        lines.append(f"{desc} {money(amt)} {money(bal.copy_abs())}")
    # 7 credits summing 226,361.00 (Cr-suffixed amount) — recover the balance.
    for i, amt in enumerate([D("37000.00")] * 6 + [D("4361.00")]):
        bal += amt
        lines.append(f"0{(i % 9) + 1} Apr Eft Credit Customer {i:03d} {money(amt)}Cr {balance_cell(bal)}")
    # 57 ordinary debits summing 224,652.09.
    for i, amt in enumerate([D("3900.00")] * 56 + [D("6252.09")]):
        bal -= amt
        lines.append(f"1{i % 9} Apr Card Purchase Merchant {i:03d} {money(amt)} {balance_cell(bal)}")
    lines.append(f"Closing Balance {money(closing)}")

    metadata = {
        "opening_balance": 342.37, "closing_balance": 368.96,
        "expected_transaction_count": 67, "expected_credit_count": 7, "expected_debit_count": 60,
        "declared_credit_total": 226361.00, "declared_debit_total": 226334.41,
    }
    txns = parse_transactions([], metadata, "\n".join(lines))

    assert_equal(len(txns), 67, f"{case_id} transaction count")
    summary = validation_summary(txns)
    assert_equal(summary["credit_count"], 7, f"{case_id} credit count")
    assert_equal(summary["debit_count"], 60, f"{case_id} debit count")
    assert_equal(str(summary["total_credits"]), "226361.00", f"{case_id} credit total")
    assert_equal(str(summary["total_debits"]), "226334.41", f"{case_id} debit total")

    # The three named rows must be present with the exact amounts.
    extracted = {(t.description, f"{(t.debit_amount or 0):.2f}") for t in txns}
    for desc, amount in [("Internal Debit Order Fnbfuneral Fi11941792A Ex6460", "676.02"),
                         ("Internal Debit Order Fnbfuneral Fi11941792 Ex6462", "696.30")]:
        if (desc, amount) not in extracted:
            raise AssertionError(f"{case_id}: missing row {desc} R{amount}")
    fee = next((t for t in txns if "excess item fee" in t.description.lower()), None)
    if fee is None or not fee.bank_charge or fee.account_category != "Bank Charges":
        raise AssertionError(f"{case_id}: #Excess Item Fee must be captured as Bank Charges, got {fee}")

    # Reconciliation must be exactly R0.00 (validate_statement raises otherwise).
    validation = validate_statement(metadata, txns)
    if validation["calculated_closing"] != validation["closing_balance"]:
        raise AssertionError(f"{case_id}: reconciliation not zero ({validation['calculated_closing']} vs {validation['closing_balance']})")
    assert_equal(str(validation["closing_balance"]), "368.96", f"{case_id} closing balance")


def run_freight_aces_case() -> None:
    # FNBBSJAN2026 (FREIGHT ACES) Gold Business statement: header
    # "Transactions in RAND (ZAR) : 62905786151", transactions across several
    # pages, "#" fee rows and rows whose description is lost (date + amount +
    # balance). Previously returned "No FNB transactions could be parsed".
    from decimal import Decimal as D

    from main import extraction_diagnostics, parse_transactions, validate_statement, validation_summary

    case_id = "freight-aces-jan"
    opening, closing = D("1869.10"), D("295242.68")

    def money(v: D) -> str:
        return f"{v:,.2f}"

    def balance_cell(v: D) -> str:
        return f"{money(v)} Cr" if v >= 0 else money(v.copy_abs())

    rows: list[tuple[str, D, bool]] = []
    # 24 credits summing 909,530.63.
    for i, amt in enumerate([D("39000.00")] * 23 + [D("12530.63")]):
        rows.append((f"Eft Credit Customer {i:03d}", amt, True))
    # 116 debits summing 616,157.05: two "#" fee rows (= declared service fees
    # 1,168.52) plus 114 others, ~11 of which lose their description.
    rows.append(("#Monthly Account Fee", D("349.00"), False))
    rows.append(("#Service Fees", D("819.52"), False))
    for i, amt in enumerate([D("5400.00")] * 113 + [D("4788.53")]):
        desc = "" if i % 10 == 0 else f"Card Purchase Merchant {i:03d}"
        rows.append((desc, amt, False))

    lines = [
        "FREIGHT ACES (PTY)LTD",
        "Account Number : 62905786151",
        "Opening Balance 1,869.10 Cr",
        "Closing Balance 295,242.68 Cr",
        "Transactions in RAND (ZAR) : 62905786151",
    ]
    bal = opening
    for idx, (desc, amt, is_credit) in enumerate(rows):
        day = f"{(idx % 28) + 1:02d} Jan"
        if is_credit:
            bal += amt
            lines.append(f"{day} {desc} {money(amt)}Cr {balance_cell(bal)}")
        else:
            bal -= amt
            lines.append(f"{day} {desc} {money(amt)} {balance_cell(bal)}".replace("  ", " "))
        if idx in (39, 79, 119):  # page breaks: carried-forward line + repeated header
            lines.append(f"Balance Brought Forward {balance_cell(bal)}")
            lines.append("Transactions in RAND (ZAR) : 62905786151")
    lines.append(f"Closing Balance {money(closing)} Cr")
    lines.append("Turnover for Statement Period")
    text = "\n".join(lines)

    metadata = {
        "opening_balance": 1869.10, "closing_balance": 295242.68,
        "expected_transaction_count": 140, "expected_credit_count": 24, "expected_debit_count": 116,
        "declared_credit_total": 909530.63, "declared_debit_total": 616157.05,
    }
    txns = parse_transactions([], metadata, text)

    # Must NOT be rejected as unparseable; diagnostics must see the section.
    diagnostics = extraction_diagnostics([], text, metadata)
    if not diagnostics["transaction_section_found"]:
        raise AssertionError(f"{case_id}: transaction section not detected")

    assert_equal(len(txns), 140, f"{case_id} transaction count")
    summary = validation_summary(txns)
    assert_equal(summary["credit_count"], 24, f"{case_id} credit count")
    assert_equal(summary["debit_count"], 116, f"{case_id} debit count")
    assert_equal(str(summary["total_credits"]), "909530.63", f"{case_id} credit total")
    assert_equal(str(summary["total_debits"]), "616157.05", f"{case_id} debit total")

    fees = [t for t in txns if t.description.startswith("#") and t.bank_charge]
    if len(fees) < 2:
        raise AssertionError(f"{case_id}: fee rows not captured as bank charges ({len(fees)})")

    validation = validate_statement(metadata, txns)
    if validation["calculated_closing"] != validation["closing_balance"]:
        raise AssertionError(f"{case_id}: reconciliation not zero ({validation['calculated_closing']} vs {validation['closing_balance']})")
    assert_equal(str(validation["closing_balance"]), "295242.68", f"{case_id} closing balance")


def run() -> None:
    run_fnb_extraction_case()
    run_statement_period_case()
    run_missing_column_fallback_case()
    run_validation_diagnostics_case()
    run_april_missing_rows_case()
    run_freight_aces_case()

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
