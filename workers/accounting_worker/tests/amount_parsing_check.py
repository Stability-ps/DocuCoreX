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

from main import parse_fnb_section_transactions, parse_money_cell, parse_transaction_amount_cell


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
    Closing Balance 11,196.46Cr
    Interest/legal footer 999,999.99
    """
    metadata = {"statement_period_end": "2026-02-28"}
    transactions = parse_fnb_section_transactions(text, metadata)
    assert_equal(len(transactions), 4, "section transaction count")
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


if __name__ == "__main__":
    run()
