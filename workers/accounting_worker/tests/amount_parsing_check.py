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
    sys.modules["fastapi.responses"] = fastapi_responses

if importlib.util.find_spec("openpyxl") is None:
    openpyxl = types.ModuleType("openpyxl")
    openpyxl.Workbook = object
    sys.modules["openpyxl"] = openpyxl

    openpyxl_styles = types.ModuleType("openpyxl.styles")
    openpyxl_styles.Font = object
    openpyxl_styles.PatternFill = object
    sys.modules["openpyxl.styles"] = openpyxl_styles

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

from main import (
    insert_inferred_fnb_service_fees,
    parse_fnb_section_transactions,
    parse_fnb_service_fee_transactions,
    parse_money_cell,
    parse_transaction_amount_cell,
    parse_transactions,
    service_fee_candidate_lines,
    transaction_candidate_lines,
)


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def run():
    assert_equal(parse_money_cell("FNB OB Pmt Rmsp 10129 25,000.00Cr"), Decimal("25000.00"), "credit reference")
    assert_equal(parse_money_cell("FNB App Payment To Lancent M22013354 232.20"), Decimal("232.20"), "app payment")
    assert_equal(parse_money_cell("Byc Debit 63012593504 8.74"), Decimal("8.74"), "byc debit")
    assert_equal(parse_money_cell("-333642412 3,652.00"), Decimal("3652.00"), "negative reference")
    assert_equal(parse_money_cell("63012593504 16.61"), Decimal("16.61"), "reference plus amount")

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
    assert_equal(len(inferred_fees), 4, "inferred fee count")
    assert_equal([row.description for row in inferred_fees], [
        "#Service Fees Intl Pmt Fee-Google Xiao",
        "#Monthly Account Fee",
        "#Service Fees",
        "#Service Fees Intl Pmt Fee-Google Chat",
    ], "inferred fee descriptions")
    assert_equal(sum(Decimal(str(row.debit_amount or 0)) for row in inferred_fees), Decimal("695.00"), "inferred fee total")
    assert_equal([row.running_balance for row in inferred_fees], [58342.32, 2317.55, 2212.55, 2202.99], "inferred fee balances")


if __name__ == "__main__":
    run()
