from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from main import ProcessRequest


def assert_old_payload_accepted() -> None:
    payload = ProcessRequest(
        run_id="run-1",
        workspace_id="ws-1",
        storage_path="workspace/ws-1/statements/s1.pdf",
        parser_method="pdfplumber",
        extraction_source="pdfplumber",
        ocr_used=False,
        pre_extracted_text="01 Jan Payment 100.00 900.00 Cr",
        extraction_debug={"selectedParser": "pdfplumber"},
    )
    assert payload.pre_extracted_text is not None
    assert payload.pre_extracted_rows is None


def assert_v2_payload_accepted() -> None:
    payload = ProcessRequest(
        run_id="run-2",
        workspace_id="ws-2",
        storage_path="workspace/ws-2/statements/s2.pdf",
        parser_method="azure_di",
        extraction_source="azure_di",
        ocr_used=True,
        pre_extracted_text="01 Jan Payment 100.00 900.00 Cr",
        extraction_format_version=2,
        pre_extracted_rows=[
            {
                "pageNumber": 1,
                "cells": {"date": "01 Jan", "description": "Payment", "amount": "100.00", "balance": "900.00 Cr"},
                "raw": "01 Jan Payment 100.00 900.00 Cr",
                "confidence": 0.98,
            }
        ],
        structured_provider="azure_di",
        structured_row_continuity=1.0,
        structured_page_count=1,
        structured_row_count=1,
        structured_diagnostics={"rowContinuity": 1, "tableCount": 1},
        extraction_debug={"selectedParser": "azure_di"},
    )
    assert payload.extraction_format_version == 2
    assert payload.structured_provider == "azure_di"
    assert payload.structured_row_count == 1
    assert payload.structured_row_continuity == 1.0
    assert payload.pre_extracted_rows is not None


if __name__ == "__main__":
    assert_old_payload_accepted()
    assert_v2_payload_accepted()
    print("request_model_check: ok")
