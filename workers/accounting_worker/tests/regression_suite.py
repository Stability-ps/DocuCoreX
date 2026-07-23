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
    apply_learned_classification_rules,
    build_combined_workbook,
    build_workbook,
    parse_metadata,
    parse_transactions,
    professional_transaction_row,
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


def run_december_multi_page_closing_balance_case() -> None:
    # Regression: multi-page OCR text can include "Closing Balance" between repeated
    # page headers. The parser must NOT stop at that intermediate line.
    from decimal import Decimal as D

    from main import parse_transactions, validate_statement, validation_summary

    case_id = "freight-aces-dec-multipage"
    opening, closing = D("4378.76"), D("97489.87")

    def money(v: D) -> str:
        return f"{v:,.2f}"

    def balance_cell(v: D) -> str:
        return f"{money(v)} Cr" if v >= 0 else money(v.copy_abs())

    credits = [D("50000.00")] * 11 + [D("12345.67")]
    debits = [D("4500.00")] * 104 + [D("1234.56")]
    rows: list[tuple[str, D, bool]] = []
    for idx, amount in enumerate(credits):
        rows.append((f"Eft Credit Customer {idx:03d}", amount, True))
    for idx, amount in enumerate(debits):
        desc = "" if idx % 11 == 0 else f"Card Purchase Merchant {idx:03d}"
        rows.append((desc, amount, False))

    lines = [
        "FREIGHT ACES (PTY)LTD",
        "Account Number : 62905786151",
        "Opening Balance 4,378.76 Cr",
        "Closing Balance 97,489.87 Cr",
        "Transactions in RAND (ZAR) : 62905786151",
    ]
    bal = opening
    for idx, (desc, amount, is_credit) in enumerate(rows):
        day = f"{(idx % 28) + 1:02d} Dec"
        if is_credit:
            bal += amount
            lines.append(f"{day} {desc} {money(amount)}Cr {balance_cell(bal)}")
        else:
            bal -= amount
            lines.append(f"{day} {desc} {money(amount)} {balance_cell(bal)}".replace("  ", " "))
        if idx in (38, 76):  # pseudo page breaks
            lines.append(f"Closing Balance {balance_cell(bal)}")
            lines.append(f"Balance Brought Forward {balance_cell(bal)}")
            lines.append("Transactions in RAND (ZAR) : 62905786151")
    lines.append("Closing Balance 97,489.87 Cr")
    lines.append("Turnover for Statement Period")
    text = "\n".join(lines)

    metadata = {
        "opening_balance": 4378.76,
        "closing_balance": 97489.87,
        "expected_transaction_count": 117,
        "expected_credit_count": 12,
        "expected_debit_count": 105,
        "declared_credit_total": 562345.67,
        "declared_debit_total": 469234.56,
    }
    txns = parse_transactions([], metadata, text)
    assert_equal(len(txns), 117, f"{case_id} transaction count")
    summary = validation_summary(txns)
    assert_equal(summary["credit_count"], 12, f"{case_id} credit count")
    assert_equal(summary["debit_count"], 105, f"{case_id} debit count")
    assert_equal(str(summary["total_credits"]), "562345.67", f"{case_id} credit total")
    assert_equal(str(summary["total_debits"]), "469234.56", f"{case_id} debit total")
    validation = validate_statement(metadata, txns)
    if validation["calculated_closing"] != validation["closing_balance"]:
        raise AssertionError(f"{case_id}: reconciliation not zero ({validation['calculated_closing']} vs {validation['closing_balance']})")


def run_compound_ocr_line_case() -> None:
    # OCR occasionally merges adjacent transaction rows onto one physical line.
    # The parser must split those compound lines back into separate movements.
    case_id = "compound-ocr-line-split"
    text = (
        "Transactions in RAND (ZAR)\n"
        "01 Dec Diesel Depot 1,200.00 8,800.00 Cr 02 Dec Eft Credit Customer Alpha 9,500.00Cr 18,300.00 Cr\n"
        "03 Dec Sanral Toll 450.00 17,850.00 Cr\n"
        "Closing Balance 17,850.00 Cr\n"
        "Turnover for Statement Period\n"
    )
    metadata = {
        "statement_period_start": "2025-12-01",
        "statement_period_end": "2025-12-31",
        "opening_balance": 10000.00,
        "closing_balance": 17850.00,
        "expected_transaction_count": 3,
        "expected_credit_count": 1,
        "expected_debit_count": 2,
        "declared_credit_total": 9500.00,
        "declared_debit_total": 1650.00,
    }
    txns = parse_transactions([], metadata, text)
    assert_equal(len(txns), 3, f"{case_id} transaction count")
    extracted = {(t.description, f"{(t.debit_amount or t.credit_amount or 0):.2f}") for t in txns}
    for expected in {
        ("Diesel Depot", "1200.00"),
        ("Eft Credit Customer Alpha", "9500.00"),
        ("Sanral Toll", "450.00"),
    }:
        if expected not in extracted:
            raise AssertionError(f"{case_id}: missing split transaction {expected}")
    validate_statement(metadata, txns)


def run_professional_classification_case() -> None:
    case_id = "professional-classification"
    fuel = ParsedTransaction(
        transaction_date="2026-01-05",
        description="Shell Diesel Depot",
        debit_amount=1500.0,
        credit_amount=None,
        running_balance=8500.0,
        bank_charge=False,
        account_category="Motor Vehicle Expenses",
        vat_treatment="standard",
        supported_by_invoice=False,
        confidence=92,
        review_status="ready",
        source_page=1,
        raw_text="05 Jan Shell Diesel Depot 1,500.00 8,500.00 Cr",
    )
    receipt = ParsedTransaction(
        transaction_date="2026-01-06",
        description="Eft Credit Customer Freight Aces",
        debit_amount=None,
        credit_amount=12500.0,
        running_balance=21000.0,
        bank_charge=False,
        account_category="Sales / Revenue",
        vat_treatment="standard",
        supported_by_invoice=False,
        confidence=92,
        review_status="ready",
        source_page=1,
        raw_text="06 Jan Eft Credit Customer Freight Aces 12,500.00Cr 21,000.00 Cr",
    )
    fuel_row = professional_transaction_row(fuel, "fixture")
    receipt_row = professional_transaction_row(receipt, "fixture")
    assert_equal(fuel_row["review_required"], False, f"{case_id} fuel review")
    assert_equal(receipt_row["review_required"], False, f"{case_id} receipt review")
    assert_equal(fuel_row["account"], "Motor Vehicle Expenses", f"{case_id} fuel account")
    assert_equal(receipt_row["account"], "Sales / Revenue", f"{case_id} receipt account")
    assert_equal(receipt_row["vat_claim_status"], "Output", f"{case_id} receipt vat")


def run_learned_supplier_rules_case() -> None:
    case_id = "learned-supplier-rules"
    transactions = [
        ParsedTransaction(
            transaction_date="2026-04-02",
            description="POS Purchase New Uber Eats 400568*7629 01 Apr",
            debit_amount=94.0,
            credit_amount=None,
            running_balance=1598939.08,
            bank_charge=False,
            account_category="Suspense / Review Required",
            vat_treatment="review",
            supported_by_invoice=False,
            confidence=55,
            review_status="needs_review",
            source_page=1,
            raw_text="02 Apr POS Purchase New Uber Eats 400568*7629 01 Apr 94.00 1,598,939.08Cr",
        ),
        ParsedTransaction(
            transaction_date="2026-04-04",
            description="POS Purchase Google Chatgpt 400568*7629 03 Apr",
            debit_amount=424.99,
            credit_amount=None,
            running_balance=1598514.09,
            bank_charge=False,
            account_category="Suspense / Review Required",
            vat_treatment="review",
            supported_by_invoice=False,
            confidence=55,
            review_status="needs_review",
            source_page=1,
            raw_text="04 Apr POS Purchase Google Chatgpt 400568*7629 03 Apr 424.99 1,598,514.09Cr",
        ),
        ParsedTransaction(
            transaction_date="2026-04-25",
            description="25 Apr Byc Debit 63012593504",
            debit_amount=8.51,
            credit_amount=None,
            running_balance=1450166.60,
            bank_charge=False,
            account_category="Suspense / Review Required",
            vat_treatment="review",
            supported_by_invoice=False,
            confidence=55,
            review_status="needs_review",
            source_page=2,
            raw_text="25 Apr Byc Debit 63012593504 8.51 1,450,166.60Cr",
        ),
        ParsedTransaction(
            transaction_date="2026-04-07",
            description="POS Purchase Sage SA 400568*7629 06 Apr",
            debit_amount=599.0,
            credit_amount=None,
            running_balance=1449567.60,
            bank_charge=False,
            account_category="Suspense / Review Required",
            vat_treatment="review",
            supported_by_invoice=False,
            confidence=55,
            review_status="needs_review",
            source_page=2,
            raw_text="07 Apr POS Purchase Sage SA 400568*7629 06 Apr 599.00 1,449,567.60Cr",
        ),
        ParsedTransaction(
            transaction_date="2026-04-08",
            description="Scheduled Payment To Home Loan Emporers Home Loan Payment",
            debit_amount=10000.0,
            credit_amount=None,
            running_balance=1439567.60,
            bank_charge=False,
            account_category="Suspense / Review Required",
            vat_treatment="review",
            supported_by_invoice=False,
            confidence=55,
            review_status="needs_review",
            source_page=2,
            raw_text="08 Apr Scheduled Payment To Home Loan Emporers Home Loan Payment 10,000.00 1,439,567.60Cr",
        ),
    ]
    rules = [
        {
            "merchant_key": "google",
            "account_category": "Software / IT",
            "vat_treatment": "review",
            "review_status": "needs_review",
            "confidence": 84,
        },
        {
            "merchant_key": "google chatgpt",
            "account_category": "Software Subscriptions",
            "vat_treatment": "standard",
            "review_status": "needs_review",
            "confidence": 90,
        },
        {
            "merchant_key": "uber eats",
            "account_category": "Staff Welfare / Meals / Entertainment",
            "vat_treatment": "review",
            "review_status": "needs_review",
            "confidence": 88,
        },
        {
            "merchant_key": "byc debit",
            "account_category": "Bank Charges",
            "vat_treatment": "standard",
            "review_status": "approved",
            "confidence": 98,
        },
        {
            "merchant_key": "sage sa",
            "account_category": "Software Subscriptions",
            "vat_treatment": "standard",
            "review_status": "needs_review",
            "confidence": 90,
        },
        {
            "merchant_key": "home loan payment",
            "account_category": "Loan / Liability",
            "vat_treatment": "out_of_scope",
            "review_status": "approved",
            "confidence": 92,
        },
    ]
    applied = apply_learned_classification_rules(transactions, rules)
    assert_equal(applied, 5, f"{case_id} applied count")
    assert_equal(transactions[0].account_category, "Staff Welfare / Meals / Entertainment", f"{case_id} uber")
    assert_equal(transactions[1].account_category, "Software Subscriptions", f"{case_id} specific google rule")
    assert_equal(transactions[2].account_category, "Bank Charges", f"{case_id} bank fee")
    assert_equal(transactions[2].review_status, "approved", f"{case_id} bank fee review status")
    assert_equal(transactions[2].confidence, 98.0, f"{case_id} bank fee confidence")
    assert_equal(transactions[3].account_category, "Software Subscriptions", f"{case_id} sage")
    assert_equal(transactions[4].account_category, "Loan / Liability", f"{case_id} home loan")
    assert_equal(transactions[4].review_status, "approved", f"{case_id} home loan review status")


def run_combined_workbook_case() -> None:
    case_id = "combined-workbook-months"
    december_run = {
        "id": "run-dec",
        "company_name": "Freight Aces (Pty) Ltd",
        "bank": "FNB South Africa",
        "account_number": "62905786151",
        "statement_period_start": "2025-12-01",
        "statement_period_end": "2025-12-31",
        "opening_balance": 1000.0,
        "closing_balance": 3200.0,
        "created_at": "2026-01-01T00:00:00",
    }
    january_run = {
        "id": "run-jan",
        "company_name": "Freight Aces (Pty) Ltd",
        "bank": "FNB South Africa",
        "account_number": "62905786151",
        "statement_period_start": "2026-01-01",
        "statement_period_end": "2026-01-31",
        "opening_balance": 3200.0,
        "closing_balance": 6400.0,
        "created_at": "2026-02-01T00:00:00",
    }
    december_txns = [
        ParsedTransaction(
            transaction_date="2025-12-05",
            description="Eft Credit Customer Afrigreen",
            debit_amount=None,
            credit_amount=4000.0,
            running_balance=5000.0,
            bank_charge=False,
            account_category="Sales / Revenue",
            vat_treatment="standard",
            supported_by_invoice=False,
            confidence=92,
            review_status="ready",
            source_page=1,
            raw_text="05 Dec Eft Credit Customer Afrigreen 4,000.00Cr 5,000.00 Cr",
        ),
        ParsedTransaction(
            transaction_date="2025-12-09",
            description="Diesel Depot",
            debit_amount=1800.0,
            credit_amount=None,
            running_balance=3200.0,
            bank_charge=False,
            account_category="Motor Vehicle Expenses",
            vat_treatment="standard",
            supported_by_invoice=False,
            confidence=92,
            review_status="ready",
            source_page=1,
            raw_text="09 Dec Diesel Depot 1,800.00 3,200.00 Cr",
        ),
    ]
    january_txns = [
        ParsedTransaction(
            transaction_date="2026-01-03",
            description="Eft Credit Customer Freight Aces",
            debit_amount=None,
            credit_amount=5000.0,
            running_balance=8200.0,
            bank_charge=False,
            account_category="Sales / Revenue",
            vat_treatment="standard",
            supported_by_invoice=False,
            confidence=92,
            review_status="ready",
            source_page=1,
            raw_text="03 Jan Eft Credit Customer Freight Aces 5,000.00Cr 8,200.00 Cr",
        ),
        ParsedTransaction(
            transaction_date="2026-01-10",
            description="Sanral Toll",
            debit_amount=1800.0,
            credit_amount=None,
            running_balance=6400.0,
            bank_charge=False,
            account_category="Road Tolls",
            vat_treatment="standard",
            supported_by_invoice=False,
            confidence=90,
            review_status="ready",
            source_page=1,
            raw_text="10 Jan Sanral Toll 1,800.00 6,400.00 Cr",
        ),
    ]
    workbook_bytes, summary = build_combined_workbook(
        [january_run, december_run],
        {"run-dec": december_txns, "run-jan": january_txns},
    )
    workbook = load_workbook(io.BytesIO(workbook_bytes), data_only=True)
    tx_sheet = workbook["Transactions"]
    source_periods = {tx_sheet.cell(row=row, column=3).value for row in range(2, tx_sheet.max_row + 1)}
    if {"2025-12-01 to 2025-12-31", "2026-01-01 to 2026-01-31"} - source_periods:
        raise AssertionError(f"{case_id}: combined workbook must preserve both statement periods")
    assert_equal(summary["transaction_count"], 4, f"{case_id} transaction count")
    assert_equal(summary["review_count"], 0, f"{case_id} review count")
    diagnostics = workbook["Diagnostics"]
    ai_row = next((row for row in range(2, diagnostics.max_row + 1) if diagnostics.cell(row=row, column=1).value == "ai"), None)
    if ai_row is None:
        raise AssertionError(f"{case_id}: combined diagnostics missing AI row")
    vat = workbook["VAT Schedule"]
    assert_equal(vat["A1"].value, "VAT Schedule & VAT Payable/(Refund)", f"{case_id} VAT title")
    assert_equal(vat["D7"].value, "Net VAT Payable/(Refund)", f"{case_id} VAT monthly net header")
    assert_equal(vat["E7"].value, "Running VAT Balance", f"{case_id} VAT running balance header")
    assert_equal(vat["A11"].value, "Date", f"{case_id} VAT detail starts after monthly summary")


def run_local_real_statement_files_case() -> None:
    """Optional guard for the two real FNB statements supplied during support.
    These files live outside the repository, so CI/deploys skip this test. On the
    affected Mac it verifies that the current parser reconciles the exact March
    and May PDFs whose older production runs displayed incorrect Money In/Out."""
    try:
        import pdfplumber
    except Exception:
        return
    if not hasattr(pdfplumber, "open"):
        return

    cases = [
        {
            "id": "real-march-2026",
            "path": Path("/Users/patric/Library/Mobile Documents/com~apple~CloudDocs/Desktop Mac Downloads/31 Mar 2026 - (Free)..A1N1WRAFCAUDGU1_EVNXHAEGdVVAU1RUVBgaIEYBVhkGAHlSEVdUVA8cGHIRB1UYUFV0AkAEBldXHxAkSgAETw.XhdUVD1zfHZqdiBmUQIBAAIFDQFtUVRWUgUCVgRUAwAFBwcDUldRXgAJAQw8UwU.pdf"),
            "credits": "7043521.68",
            "debits": "5388160.19",
            "closing": "1666557.95",
        },
        {
            "id": "real-may-2026",
            "path": Path("/Users/patric/Library/Mobile Documents/com~apple~CloudDocs/Desktop Mac Downloads/30 May 2026 - (Free)..CgYpVEALUQoGSxsjSlRWGQFSeAVJBwQCBE5KJEdRBB8DUS4FTAIEBwYbGSAQAQcYAAUpVExUUgoCSB1yEV0ASg.V0MIWWZ9JXlvJHY6CgUABQJQAFFvBQQAAlNSUgUEUQYAV1BUBAIBDQkOAF49VVc.pdf"),
            "credits": "12214591.85",
            "debits": "6758364.90",
            "closing": "6957593.75",
        },
    ]

    for case in cases:
        pdf_path = case["path"]
        if not pdf_path.exists():
            continue
        pages = []
        full_text_parts = []
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_number, page in enumerate(pdf.pages, start=1):
                text = page.extract_text() or ""
                pages.append({"page": page_number, "text": text, "tables": []})
                full_text_parts.append(text)
        full_text = "\n".join(full_text_parts)
        metadata = parse_metadata(full_text)
        transactions = parse_transactions(pages, metadata, full_text)
        validation = validate_statement(metadata, transactions)
        summary = validation_summary(transactions)
        assert_equal(str(summary["total_credits"]), case["credits"], f"{case['id']} credits")
        assert_equal(str(summary["total_debits"]), case["debits"], f"{case['id']} debits")
        assert_equal(str(validation["closing_balance"]), case["closing"], f"{case['id']} closing")


def run() -> None:
    run_fnb_extraction_case()
    run_statement_period_case()
    run_missing_column_fallback_case()
    run_validation_diagnostics_case()
    run_april_missing_rows_case()
    run_freight_aces_case()
    run_december_multi_page_closing_balance_case()
    run_compound_ocr_line_case()
    run_professional_classification_case()
    run_learned_supplier_rules_case()
    run_combined_workbook_case()
    run_local_real_statement_files_case()

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
