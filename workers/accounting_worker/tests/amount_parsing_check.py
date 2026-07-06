from decimal import Decimal
import importlib.util
from pathlib import Path
import sys
import types

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
    fastapi_responses.Response = object
    sys.modules["fastapi.responses"] = fastapi_responses

if importlib.util.find_spec("openpyxl") is None:
    openpyxl = types.ModuleType("openpyxl")
    openpyxl.Workbook = object
    sys.modules["openpyxl"] = openpyxl

    openpyxl_styles = types.ModuleType("openpyxl.styles")

    class StyleStub:
        def __init__(self, *args, **kwargs):
            pass

    openpyxl_styles.Alignment = StyleStub
    openpyxl_styles.Border = StyleStub
    openpyxl_styles.Font = StyleStub
    openpyxl_styles.PatternFill = StyleStub
    openpyxl_styles.Side = StyleStub
    sys.modules["openpyxl.styles"] = openpyxl_styles

    openpyxl_utils = types.ModuleType("openpyxl.utils")
    openpyxl_utils.get_column_letter = lambda index: chr(64 + index) if index <= 26 else f"COL{index}"
    sys.modules["openpyxl.utils"] = openpyxl_utils

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
else:
    import supabase

    if not hasattr(supabase, "Client"):
        supabase.Client = object
    if not hasattr(supabase, "create_client"):
        def create_client(*args, **kwargs):
            return object()

        supabase.create_client = create_client

from main import (
    ParsedTransaction,
    balance_gap_diagnostics,
    bank_charges_from_statement,
    classify_transaction,
    detect_company_name,
    insert_inferred_fnb_service_fees,
    looks_like_address,
    parse_hash_fee_lines,
    parse_single_amount_line,
    parse_transactions,
    parse_metadata,
    validate_extraction,
    parse_fnb_section_transactions,
    parse_fnb_service_fee_transactions,
    parse_money_cell,
    parse_transaction_amount_cell,
    parse_transactions,
    extraction_diagnostics,
    service_fee_candidate_lines,
    strip_fnb_page_artifacts,
    transaction_candidate_lines,
)


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def make_txn(debit=None, credit=None):
    return ParsedTransaction(
        transaction_date="2026-03-10",
        description="row",
        debit_amount=debit,
        credit_amount=credit,
    )


def run():
    assert_equal(parse_money_cell("FNB OB Pmt Rmsp 10129 25,000.00Cr"), Decimal("25000.00"), "credit reference")
    assert_equal(parse_money_cell("FNB App Payment To Lancent M22013354 232.20"), Decimal("232.20"), "app payment")
    assert_equal(parse_money_cell("Byc Debit 63012593504 8.74"), Decimal("8.74"), "byc debit")
    assert_equal(parse_money_cell("-333642412 3,652.00"), Decimal("3652.00"), "negative reference")
    assert_equal(parse_money_cell("63012593504 16.61"), Decimal("16.61"), "reference plus amount")
    metadata = parse_metadata("""
    Bank VAT Registration Number 4210102051
    ALLIANZ HOLDINGS (PTY) LTD
    Waterfall Office Park
    Platinum Business Account 63012589818
    Period 01 Feb 2026 to 28 Feb 2026
    Opening Balance 111,600.56
    Closing Balance 11,196.46
    """)
    assert_equal(metadata["company_name"], "ALLIANZ HOLDINGS (PTY) LTD", "allianz company name")
    assert_equal(metadata["account_number"], "63012589818", "allianz account number")

    # Regression: the company name must be the account holder, NEVER an address
    # line (fixes "ITALA PLACE" / "MOOIKLOOF" being used as the company name).
    acapolite = parse_metadata("""
    ACAPOLITE CONSULTING (PTY) LTD
    12 ITALA PLACE
    MOOIKLOOF
    PRETORIA
    0059
    Account Number: 62811110000
    Statement Period 01 Mar 2026 to 31 Mar 2026
    Opening Balance 50,000.00
    Closing Balance 62,340.10
    """)
    assert_equal(acapolite["company_name"], "ACAPOLITE CONSULTING (PTY) LTD", "acapolite company name")
    assert_equal(acapolite["account_number"], "62811110000", "acapolite account number")

    # Address lines must be classified as addresses.
    for addr in ["12 ITALA PLACE", "MOOIKLOOF", "PRETORIA", "0059", "P O BOX 1234", "45 Main Street"]:
        if not looks_like_address(addr):
            raise AssertionError(f"expected address: {addr!r}")
    # Real companies must NOT be classified as addresses.
    for name in ["ACAPOLITE CONSULTING (PTY) LTD", "MABENA TRADING CC", "SMITH & SONS INC"]:
        if looks_like_address(name):
            raise AssertionError(f"company misclassified as address: {name!r}")
    # A personal statement (no legal suffix) still resolves to the holder name, not the address.
    assert_equal(
        detect_company_name("JOHN P SMITH\n88 OAK AVENUE\nSANDTON\n2196\nStatement Period 01 Jan to 31 Jan"),
        "JOHN P SMITH",
        "personal account holder",
    )

    # Regression for the exact ACAPOLITE statement bug: company name must stop at
    # the legal suffix (no "Universal Branch Code"), and the account number must
    # be the FNB 11-digit account, never a short reference number like 753665.
    acap = parse_metadata("""
    ACAPOLITE CONSULTING (PTY) LTD Universal Branch Code 250655
    12 Itala Place
    Mooikloof
    Pretoria
    0059
    Delivery Reference 753665
    Gold Business Account : 63041819765
    Statement Period 28 Feb 2026 to 31 Mar 2026
    Opening Balance 3,390.09
    Closing Balance 342.37
    """)
    assert_equal(acap["company_name"], "ACAPOLITE CONSULTING (PTY) LTD", "acapolite clean company name")
    assert_equal(acap["account_number"], "63041819765", "acapolite fnb account number")
    if "Universal Branch Code" in (acap["company_name"] or ""):
        raise AssertionError("company name still contains branch code")
    if acap["account_number"] == "753665":
        raise AssertionError("account number is the wrong reference number 753665")
    # Categorisation: common FNB patterns must NOT fall through to Uncategorised.
    for desc, expected_account in [
        ("# Cash Deposit Fee", "Bank Charges"),
        ("# Monthly Account Fee", "Bank Charges"),
        ("# Service Fees", "Bank Charges"),
        ("FNB App Prepaid Airtime", "Telephone / Internet / Communication"),
        ("Internal Debit Order Fnbfuneral Fi11941792", "Insurance Expense"),
        ("FNB App Transfer To Savings", "Inter-account Transfer"),
    ]:
        account, _vat, _bc, _conf = classify_transaction(desc, 100.0, None)
        assert_equal(account, expected_account, f"category for {desc!r}")

    # Accounting-accuracy regressions: these must NOT land in P&L income/expense
    # or Bank Charges.
    dep_acct, _v, dep_bc, _c = classify_transaction("ADT Cash Deposit Woodland", None, 23550.0)
    assert_equal(dep_acct, "Cash Deposits / Revenue", "ADT cash deposit account")
    assert_equal(dep_bc, False, "ADT cash deposit must not be a bank charge")
    tax_acct, _v, _b, _c = classify_transaction("Tax Deposit", None, 120000.0)
    assert_equal(tax_acct, "SARS / Tax Suspense", "tax deposit account")
    assert_equal(classify_transaction("Refund Client X", 35000.0, None)[0], "Refund / Suspense", "refund account")
    assert_equal(classify_transaction("Loan Repayment Wesbank", 500.0, None)[0], "Loan / Liability", "loan account")
    fee_acct, _v, fee_bc, _c = classify_transaction("# Cash Deposit Fee", 599.44, None)
    assert_equal(fee_acct, "Bank Charges", "cash deposit FEE is a bank charge")
    assert_equal(fee_bc, True, "cash deposit fee bank_charge flag")

    # Generic (not name-specific) related-party / suspense classification.
    assert_equal(classify_transaction("FNB App Rtc Pmt To Thabo", 5000.0, None)[0], "Related Party / Drawings", "payment to a name")
    assert_equal(classify_transaction("FNB App Payment To 819035690", 3000.0, None)[0], "Suspense / Review Required", "payment to a number")
    assert_equal(classify_transaction("PayShap To Nomsa", 1200.0, None)[0], "Related Party / Drawings", "payshap to a name")
    # An unknown debit must NOT become an Operating Expense by default.
    assert_equal(classify_transaction("Some Unknown Vendor XYZ", 999.0, None)[0], "Suspense / Review Required", "unknown debit is suspense")

    # Statement summary extraction (declared ground truth, any bank).
    summary_meta = parse_metadata("\n".join([
        "ACAPOLITE CONSULTING (PTY) LTD",
        "Gold Business Account : 63041819765",
        "Statement Period 28 Feb 2026 to 31 Mar 2026",
        "Opening Balance 3,390.09",
        "Closing Balance 342.37",
        "Credit Transactions 15 419,700.00",
        "Debit Transactions 128 422,747.72",
        "Service Fees 616.80",
        "Cash Deposit Fees 599.44",
        "Total VAT 158.64",
    ]))
    assert_equal(summary_meta["expected_credit_count"], 15, "declared credit count")
    assert_equal(summary_meta["expected_debit_count"], 128, "declared debit count")
    assert_equal(summary_meta["expected_transaction_count"], 143, "declared total count")
    assert_equal(summary_meta["declared_credit_total"], 419700.0, "declared credit total")
    assert_equal(summary_meta["declared_debit_total"], 422747.72, "declared debit total")
    assert_equal(summary_meta["declared_service_fees"], 616.80, "declared service fees")
    assert_equal(summary_meta["declared_cash_deposit_fees"], 599.44, "declared cash deposit fees")
    assert_equal(summary_meta["declared_total_vat"], 158.64, "declared total VAT")

    # Bank charges come from the declared fee summary even if fee rows are missed
    # (never R0, never a cash-deposit amount).
    charges = bank_charges_from_statement(summary_meta, [])
    assert_equal(str(charges), "1216.24", "bank charges from declared summary")

    # General extraction validation: complete vs incomplete.
    complete = (
        [make_txn(credit=(405700.00 if i == 0 else 1000.00)) for i in range(15)]
        + [make_txn(debit=(295747.72 if i == 0 else 1000.00)) for i in range(128)]
    )
    ok = validate_extraction(summary_meta, complete)
    assert_equal(ok["status"], "ok", "complete extraction validates")
    assert_equal(ok["reconciliation_difference"], "0.00", "complete extraction reconciles")

    incomplete = complete[:-1]  # drop one debit (a "missing row")
    bad = validate_extraction(summary_meta, incomplete)
    assert_equal(bad["status"], "review_required", "incomplete extraction flagged")
    if "reconciliation" not in bad["failures"] or "transaction_count" not in bad["failures"]:
        raise AssertionError(f"missing-row validation failures wrong: {bad['failures']}")

    # Regression for the 6 rows that failed to extract on the ACAPOLITE statement
    # (single-amount rows and #-prefixed fee lines with no running balance).
    acap_statement = "\n".join([
        "ACAPOLITE CONSULTING (PTY) LTD Universal Branch Code 250655",
        "Gold Business Account : 63041819765",
        "Statement Period 28 Feb 2026 to 31 Mar 2026",
        "Opening Balance 3,390.09",
        "Closing Balance 342.37",
        "Credit Transactions 15",
        "Debit Transactions 128",
        "Transactions in Rand (ZAR)",
        "01 Mar FNB OB Pmt From Client 10,000.00 13,390.09Cr",
        "02 Mar Internal Debit Order Fnbfuneral Fi11941792 J62730 696.30",
        "18 Mar FNB App Payment To 819035690 3,000.00",
        "18 Mar FNB App Rtc Pmt To Patric 25,000.00",
        "Closing Balance 342.37",
        "24 Mar # Monthly Account Fee 93.00",
        "24 Mar # Service Fees 523.80",
        "24 Mar # Cash Deposit Fee 599.44",
    ])
    acap_meta = parse_metadata(acap_statement)
    assert_equal(acap_meta["expected_transaction_count"], 143, "acapolite expected turnover count")

    txns = parse_transactions([], acap_meta, acap_statement)
    descriptions = " || ".join(t.description.lower() for t in txns)
    for fragment in [
        "internal debit order fnbfuneral",
        "app payment to 819035690",
        "app rtc pmt to patric",
        "monthly account fee",
        "service fees",
        "cash deposit fee",
    ]:
        if fragment not in descriptions:
            raise AssertionError(f"missing extracted row: {fragment!r}")

    # The 3 #-prefixed fees must be captured as bank charges (bank_charge=True)
    # so bank charges are no longer R0.
    bank_charges_total = sum(
        (t.debit_amount or 0) for t in txns if t.bank_charge and (t.debit_amount or 0) > 0
    )
    fee_amounts = {round(t.debit_amount or 0, 2) for t in txns if t.bank_charge}
    for expected_fee in (93.00, 523.80, 599.44):
        if expected_fee not in fee_amounts:
            raise AssertionError(f"bank charge fee not extracted: {expected_fee}")
    if round(bank_charges_total, 2) < 1216.24:
        raise AssertionError(f"bank charges too low (R0 bug): {bank_charges_total}")

    # The 3 single-amount debit rows must be captured with their amounts.
    debit_amounts = {round(t.debit_amount or 0, 2) for t in txns if (t.debit_amount or 0) > 0}
    for expected_debit in (696.30, 3000.00, 25000.00):
        if expected_debit not in debit_amounts:
            raise AssertionError(f"single-amount debit row not extracted: {expected_debit}")

    # Direct unit checks on the two new parsers.
    fees = parse_hash_fee_lines("24 Mar # Cash Deposit Fee 599.44", {"statement_period_end": "2026-03-31"})
    assert_equal(len(fees), 1, "hash fee parser count")
    assert_equal(fees[0].bank_charge, True, "hash fee is a bank charge")
    single = parse_single_amount_line("18 Mar FNB App Rtc Pmt To Patric 25,000.00", {"statement_period_end": "2026-03-31"})
    assert_equal(single is not None, True, "single amount row parsed")
    assert_equal(round(single.debit_amount, 2), 25000.00, "single amount debit value")

    debit, credit = parse_transaction_amount_cell("10129 25,000.00Cr") or (None, None)
    assert_equal(debit, None, "credit debit side")
    assert_equal(credit, 25000.0, "credit credit side")

    debit, credit = parse_transaction_amount_cell("M22013354 232.20") or (None, None)
    assert_equal(debit, 232.2, "debit debit side")
    assert_equal(credit, None, "debit credit side")

    text = """
    Header
    Transactions in RAND (ZAR)
    09 Feb FNB App Rtc Pmt To Themba Kerusha 6,400.00 33,343.76Cr 15.00
    09 Feb FNB OB Pmt Rmsp 10129 25,000.00Cr 58,343.76Cr
    23 Feb FNB OB Pmt Rmsp Inv 10130 129,375.00Cr 213,225.02Cr
    28 Feb FNB App Transfer From Credit 10,000.00Cr 11,202.99Cr
    11 Feb #Service Fees Intl Pmt Fee-Google Xiao 1.44 58,342.32Cr
    26 Feb #Monthly Account Fee 579.00 2,317.55Cr
    26 Feb #Service Fees 105.00 2,212.55Cr
    27 Feb #Service Fees Intl Pmt Fee-Google Chat 9.56 2,202.99Cr
    Closing Balance 11,196.46Cr
    Interest/legal footer 999,999.99
    """
    metadata = {"statement_period_end": "2026-02-28"}
    transactions = parse_fnb_section_transactions(text, metadata)
    assert_equal(len(transactions), 8, "section transaction count")
    assert_equal(transactions[0].transaction_date, "2026-02-09", "debit date")
    assert_equal(transactions[0].description, "FNB App Rtc Pmt To Themba Kerusha", "debit description")
    assert_equal(transactions[0].debit_amount, 6400.0, "debit amount")
    assert_equal(transactions[0].credit_amount, None, "debit credit")
    assert_equal(transactions[0].running_balance, 33343.76, "debit balance")
    assert_equal(transactions[0].notes, "Accrued bank charges: 15.00", "accrued charges")
    assert_equal(transactions[1].description, "FNB OB Pmt Rmsp 10129", "credit reference description")
    assert_equal(transactions[1].debit_amount, None, "credit debit side")
    assert_equal(transactions[1].credit_amount, 25000.0, "credit amount")
    assert_equal(transactions[1].running_balance, 58343.76, "credit balance")
    assert_equal(transactions[2].credit_amount, 129375.0, "large credit amount")
    assert_equal(transactions[3].credit_amount, 10000.0, "transfer from credit amount")
    assert_equal(transactions[4].description, "#Service Fees Intl Pmt Fee-Google Xiao", "intl fee description")
    assert_equal(transactions[4].debit_amount, 1.44, "intl fee debit")
    assert_equal(transactions[4].credit_amount, None, "intl fee credit")
    assert_equal(transactions[4].running_balance, 58342.32, "intl fee balance")
    assert_equal(transactions[5].description, "#Monthly Account Fee", "monthly fee description")
    assert_equal(transactions[5].debit_amount, 579.0, "monthly fee debit")
    assert_equal(transactions[6].description, "#Service Fees", "service fees description")
    assert_equal(transactions[6].debit_amount, 105.0, "service fees debit")
    assert_equal(transactions[7].description, "#Service Fees Intl Pmt Fee-Google Chat", "chat fee description")
    assert_equal(transactions[7].debit_amount, 9.56, "chat fee debit")

    wrapped_text = """
    Transactions in RAND (ZAR)
    11 Feb #Service Fees Intl Pmt Fee-Google Xiao
    1.44 58,342.32Cr
    26 Feb #Monthly Account Fee
    579.00 2,317.55Cr
    Closing Balance 11,196.46Cr
    Footer 123.45
    """
    candidates = transaction_candidate_lines(wrapped_text)
    assert_equal(candidates[0], "11 Feb #Service Fees Intl Pmt Fee-Google Xiao 1.44 58,342.32Cr", "wrapped fee row")
    assert_equal(candidates[1], "26 Feb #Monthly Account Fee 579.00 2,317.55Cr", "wrapped monthly row")
    wrapped_transactions = parse_fnb_section_transactions(wrapped_text, metadata)
    assert_equal(len(wrapped_transactions), 2, "wrapped transaction count")
    assert_equal(wrapped_transactions[0].debit_amount, 1.44, "wrapped intl fee debit")
    assert_equal(wrapped_transactions[1].debit_amount, 579.0, "wrapped monthly fee debit")

    outside_section_text = """
    Header
    Transactions in RAND (ZAR)
    09 Feb FNB OB Pmt Rmsp 10129 25,000.00Cr 58,343.76Cr
    Closing Balance 11,196.46Cr
    Accrued Bank Charges
    11 Feb #Service Fees Intl Pmt Fee-Google Xiao 1.44 58,342.32Cr
    26 Feb #Monthly Account Fee
    579.00 2,317.55Cr
    26 Feb #Service Fees 105.00 2,212.55Cr
    27 Feb #Service Fees Intl Pmt Fee-Google Chat
    9.56 2,202.99Cr
    Legal footer 999,999.99
    """
    fee_candidates = service_fee_candidate_lines(outside_section_text)
    assert_equal(len(fee_candidates), 4, "outside-section fee candidate count")
    outside_fees = parse_fnb_service_fee_transactions(outside_section_text, metadata)
    assert_equal(len(outside_fees), 4, "outside-section fee transaction count")
    assert_equal(sum(Decimal(str(row.debit_amount or 0)) for row in outside_fees), Decimal("695.00"), "outside-section fee total")
    merged_transactions = parse_transactions([], metadata, outside_section_text)
    assert_equal(len(merged_transactions), 5, "merged section plus fee transaction count")
    assert_equal(sum(Decimal(str(row.debit_amount or 0)) for row in merged_transactions), Decimal("695.00"), "merged fee total")
    diag = extraction_diagnostics(
        [
            {"page": 1, "text": "Transactions in RAND (ZAR)\n09 Feb FNB OB Pmt Rmsp 10129 25,000.00Cr 58,343.76Cr\nClosing Balance 11,196.46Cr"},
            {"page": 2, "text": "Transactions in RAND (ZAR)\n11 Feb #Service Fees Intl Pmt Fee-Google Xiao 1.44 58,342.32Cr"},
        ],
        outside_section_text,
        metadata,
    )
    if not isinstance(diag.get("page_diagnostics"), list) or len(diag["page_diagnostics"]) < 2:
        raise AssertionError("page-level diagnostics must include one entry per page")
    if not any(int(page.get("parsed_candidate_count") or 0) > 0 for page in diag["page_diagnostics"]):
        raise AssertionError("page-level diagnostics must report parsed candidates")

    first_gap_transactions = parse_fnb_section_transactions(
        """
        Transactions in RAND (ZAR)
        11 Feb POS Purchase New Uber Eats 400568*7629 10 Feb 454.00 57,888.32Cr
        Closing Balance 57,888.32Cr
        """,
        {"statement_period_end": "2026-02-28", "opening_balance": 58343.76},
    )
    second_gap_transactions = parse_fnb_section_transactions(
        """
        Transactions in RAND (ZAR)
        28 Feb Payshap Account Off-Us Isabel 1,000.00 1,202.99Cr
        Closing Balance 1,202.99Cr
        """,
        {"statement_period_end": "2026-02-28", "opening_balance": 2896.55},
    )
    first_inferred = insert_inferred_fnb_service_fees(
        first_gap_transactions,
        {"statement_period_end": "2026-02-28", "opening_balance": 58343.76},
    )
    second_inferred = insert_inferred_fnb_service_fees(
        second_gap_transactions,
        {"statement_period_end": "2026-02-28", "opening_balance": 2896.55},
    )
    inferred_fees = [row for row in [*first_inferred, *second_inferred] if row.description.startswith("#")]
    assert_equal(len(inferred_fees), 2, "inferred fee count")
    assert_equal([row.description for row in inferred_fees], [
        "#Monthly Account Fee / Service Fees - inferred from balance movement",
        "#Monthly Account Fee / Service Fees - inferred from balance movement",
    ], "inferred fee descriptions")
    assert_equal(sum(Decimal(str(row.debit_amount or 0)) for row in inferred_fees), Decimal("695.00"), "inferred fee total")
    assert_equal([row.running_balance for row in inferred_fees], [58342.32, 2202.99], "inferred fee balances")

    march_header_line = (
        "27 Mar POS Purchase Mytheresa.Com Int91 400568*7629 26 Mar 48,276.30 3,490,330.08Cr "
        "Page 2 of 3 Delivery Method F1 R02 Branch Number Account Number Date DDA BE/48/BT/KY/KY/BF/B9/C6/CK/N "
        "FN NS/EM/WV/DDA BE 921 921 63012589818 2026/03/31 PLATINUM BUSINESS ACCOUNT 653971 "
        "Accrued Date Description Amount Balance Bank Charges"
    )
    assert_equal(
        strip_fnb_page_artifacts(march_header_line),
        "27 Mar POS Purchase Mytheresa.Com Int91 400568*7629 26 Mar 48,276.30 3,490,330.08Cr",
        "march page header stripped from transaction row",
    )
    march_text = f"""
    Transactions in RAND (ZAR)
    26 Mar Magtape Credit 047-Gp Hea-000045705 1,980,988.88Cr 3,539,295.94Cr
    {march_header_line}
    27 Mar POS Purchase New Uber Eats 400568*7629 26 Mar 1,234.00 3,489,096.08Cr
    Closing Balance 1,666,557.95Cr
    """
    march_candidates = transaction_candidate_lines(march_text)
    assert_equal(len(march_candidates), 3, "march page header does not create or join transaction")
    assert_equal(
        march_candidates[1],
        "27 Mar POS Purchase Mytheresa.Com Int91 400568*7629 26 Mar 48,276.30 3,490,330.08Cr",
        "march header candidate cleaned",
    )
    march_transactions = parse_fnb_section_transactions(march_text, {"statement_period_end": "2026-03-31"})
    assert_equal(march_transactions[1].description, "POS Purchase Mytheresa.Com Int91 400568*7629 26 Mar", "march transaction description cleaned")
    assert_equal(march_transactions[1].debit_amount, 48276.3, "march transaction debit")
    assert_equal(march_transactions[1].running_balance, 3490330.08, "march transaction balance")

    march_gap_transactions = parse_fnb_section_transactions(
        """
        Transactions in RAND (ZAR)
        31 Mar POS Purchase New Uber Eats 400568*7629 30 Mar 100.00 1,666,557.95Cr
        Closing Balance 1,666,557.95Cr
        """,
        {"statement_period_end": "2026-03-31", "opening_balance": 1667347.51},
    )
    march_inferred = insert_inferred_fnb_service_fees(
        march_gap_transactions,
        {"statement_period_end": "2026-03-31", "opening_balance": 1667347.51},
    )
    march_inferred_fees = [row for row in march_inferred if row.description.startswith("#")]
    assert_equal(len(march_inferred_fees), 1, "march inferred fee count")
    assert_equal([row.description for row in march_inferred_fees], ["#Monthly Account Fee / Service Fees - inferred from balance movement"], "march inferred fee descriptions")
    assert_equal(sum(Decimal(str(row.debit_amount or 0)) for row in march_inferred_fees), Decimal("689.56"), "march inferred fee total")
    assert_equal(march_inferred_fees[0].notes, "inferred_service_fee: true; reason: running balance gap; gap_amount: 689.56", "march inferred diagnostics")
    assert_equal(balance_gap_diagnostics({"opening_balance": 1667347.51}, march_inferred), [], "march inferred rows close balance gap")

    april_gap_transactions = parse_fnb_section_transactions(
        """
        Transactions in RAND (ZAR)
        24 Apr FNB App Payment To Modco Interiors Invoice 1688 566,633.46 1,450,870.67Cr
        25 Apr Byc Debit 63012593504 8.51 1,450,166.60Cr
        Closing Balance 1,501,366.80Cr
        """,
        {"statement_period_end": "2026-04-30", "opening_balance": 2017504.13},
    )
    april_inferred = insert_inferred_fnb_service_fees(
        april_gap_transactions,
        {"statement_period_end": "2026-04-30", "opening_balance": 2017504.13},
    )
    april_inferred_fees = [row for row in april_inferred if row.description.startswith("#")]
    assert_equal(len(april_inferred_fees), 1, "april inferred fee count")
    assert_equal(april_inferred_fees[0].description, "#Monthly Account Fee / Service Fees - inferred from balance movement", "april inferred fee description")
    assert_equal(april_inferred_fees[0].debit_amount, 695.56, "april inferred fee amount")
    assert_equal(april_inferred_fees[0].transaction_date, "2026-04-25", "april inferred fee date")
    assert_equal(april_inferred_fees[0].account_category, "Bank Charges", "april inferred fee category")
    assert_equal(april_inferred_fees[0].notes, "inferred_service_fee: true; reason: running balance gap; gap_amount: 695.56", "april inferred diagnostics")
    assert_equal(balance_gap_diagnostics({"opening_balance": 2017504.13}, april_inferred), [], "april inferred rows close balance gap")


if __name__ == "__main__":
    run()
