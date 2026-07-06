from __future__ import annotations

import importlib.util
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
    openpyxl_utils.get_column_letter = lambda index: f"COL{index}"
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

    pydantic.BaseModel = BaseModel
    sys.modules["pydantic"] = pydantic

if importlib.util.find_spec("supabase") is None:
    supabase = types.ModuleType("supabase")
    supabase.Client = object
    supabase.create_client = lambda *args, **kwargs: object()
    sys.modules["supabase"] = supabase

import main


def assert_equal(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def run_scanned_ocr_path_check() -> None:
    payload = main.ProcessRequest(run_id="r1", workspace_id="w1", storage_path="a.pdf", document_id="d1")
    captured = {"cached": False, "ocr": False}

    main.detect_pdf_type = lambda _bytes: ("scanned", 4, [])  # type: ignore[assignment]
    main.get_cached_ocr_result = lambda *_args, **_kwargs: None  # type: ignore[assignment]

    def fake_ocr(_bytes):
        captured["ocr"] = True
        return b"ocr-pdf", {"engine": "ocrmypdf", "jobs": 1, "duration_ms": 1200}

    main.run_ocrmypdf = fake_ocr  # type: ignore[assignment]
    main.extract_statement_text = lambda _bytes: [{"page": 1, "text": "FNB OCR line 1\nline 2", "tables": []}]  # type: ignore[assignment]

    def fake_cache(*_args, **_kwargs):
        captured["cached"] = True

    main.cache_ocr_result = fake_cache  # type: ignore[assignment]

    pages, text, last_step, parser_debug, ocr_debug = main.extract_statement_content(object(), payload, b"%PDF")
    assert_equal(last_step, "ocr_completed", "scanned OCR step")
    assert_equal(bool(ocr_debug.get("used")), True, "scanned OCR used")
    assert_equal(parser_debug.get("source"), "ocr_output", "scanned parser source")
    assert_equal(bool(captured["ocr"]), True, "scanned OCR called")
    assert_equal(bool(captured["cached"]), True, "scanned OCR cache write")
    assert_equal(len(pages), 1, "scanned OCR pages")
    assert_equal("FNB OCR line 1" in text, True, "scanned OCR text")


def run_cached_ocr_reuse_check() -> None:
    payload = main.ProcessRequest(run_id="r2", workspace_id="w1", storage_path="b.pdf", document_id="d2")
    main.detect_pdf_type = lambda _bytes: ("scanned", 6, [])  # type: ignore[assignment]
    main.get_cached_ocr_result = lambda *_args, **_kwargs: {"text": "cached OCR text", "confidence": 91, "created_at": "2026-07-06"}  # type: ignore[assignment]
    main.run_ocrmypdf = lambda _bytes: (_ for _ in ()).throw(AssertionError("OCR should not run when cache exists"))  # type: ignore[assignment]
    pages, text, last_step, parser_debug, ocr_debug = main.extract_statement_content(object(), payload, b"%PDF")
    assert_equal(last_step, "ocr_cached", "cached OCR step")
    assert_equal(bool(ocr_debug.get("cached")), True, "cached OCR flag")
    assert_equal(parser_debug.get("source"), "ocr_cache", "cached parser source")
    assert_equal(text, "cached OCR text", "cached OCR text value")
    assert_equal(len(pages), 1, "cached OCR pages")


def run_digital_skip_ocr_check() -> None:
    payload = main.ProcessRequest(run_id="r3", workspace_id="w1", storage_path="c.pdf", document_id="d3")
    main.detect_pdf_type = lambda _bytes: ("digital", 1400, [{"page": 1, "text": "digital", "tables": []}])  # type: ignore[assignment]
    main.extract_text_with_pdfplumber = lambda _bytes: [{"page": 1, "text": "Large selectable PDF text " * 20, "tables": []}]  # type: ignore[assignment]
    main.run_ocrmypdf = lambda _bytes: (_ for _ in ()).throw(AssertionError("OCR should not run for digital PDFs"))  # type: ignore[assignment]
    pages, text, last_step, parser_debug, ocr_debug = main.extract_statement_content(object(), payload, b"%PDF")
    assert_equal(last_step, "pdf_text_extraction", "digital extraction step")
    assert_equal(parser_debug.get("source"), "pdfplumber", "digital parser source")
    assert_equal(bool(ocr_debug.get("used")), False, "digital OCR unused")
    assert_equal("Large selectable PDF text" in text, True, "digital text")
    assert_equal(len(pages), 1, "digital pages")


def run() -> None:
    run_scanned_ocr_path_check()
    run_cached_ocr_reuse_check()
    run_digital_skip_ocr_check()


if __name__ == "__main__":
    run()
    print("Accounting OCR flow checks passed.")
