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


def assert_bank_detection_payload_accepted() -> None:
    """The Node pipeline's bank verdict travels with the request."""
    payload = ProcessRequest(
        run_id="run-3",
        workspace_id="ws-3",
        storage_path="ws-3/accounting/fnb/2f6c-Standard_Bank_Statement.pdf",
        parser_method="azure_di",
        extraction_source="azure_di",
        ocr_used=False,
        pre_extracted_text="STANDARD BANK 6 month statement\nwww.standardbank.co.za",
        detected_bank="standard_bank_business_v1",
        detected_bank_name="Standard Bank",
        detected_bank_confidence=99.0,
        detected_bank_reason="matched_bank_markers",
        detected_bank_evidence=["standard bank (header)", "standardbank.co.za (header)"],
    )
    assert payload.detected_bank == "standard_bank_business_v1"
    assert payload.detected_bank_name == "Standard Bank"
    assert payload.detected_bank_confidence == 99.0
    assert payload.detected_bank_reason == "matched_bank_markers"
    assert payload.detected_bank_evidence == ["standard bank (header)", "standardbank.co.za (header)"]


def assert_unknown_bank_is_distinct_from_an_older_frontend() -> None:
    """"Looked and found nothing" must not arrive as "never looked".

    The worker branches on these differently: `unknown` is a verdict from a
    frontend that ran detection, None is a request from a deploy that predates
    it. Collapsing them would hide how often detection is failing.
    """
    looked = ProcessRequest(
        run_id="run-4",
        workspace_id="ws-4",
        storage_path="ws-4/accounting/fnb/statement.pdf",
        detected_bank="unknown",
        detected_bank_name="Unknown",
        detected_bank_confidence=0.0,
        detected_bank_reason="no_bank_markers_found",
        detected_bank_evidence=[],
    )
    assert looked.detected_bank == "unknown"
    assert looked.detected_bank_evidence == []

    never_looked = ProcessRequest(
        run_id="run-5",
        workspace_id="ws-5",
        storage_path="ws-5/accounting/fnb/statement.pdf",
    )
    assert never_looked.detected_bank is None
    assert never_looked.detected_bank_name is None
    assert never_looked.detected_bank_confidence is None
    assert never_looked.detected_bank_evidence is None


def assert_old_payload_still_accepted_without_bank_fields() -> None:
    """A worker deploy must keep serving the frontend deploy that precedes it."""
    payload = ProcessRequest(
        run_id="run-6",
        workspace_id="ws-6",
        storage_path="ws-6/accounting/fnb/statement.pdf",
        parser_method="pdfplumber",
        pre_extracted_text="01 Jan Payment 100.00 900.00 Cr",
        extraction_format_version=2,
        pre_extracted_rows=[{"pageNumber": 1, "cells": {"date": "01 Jan", "description": "Payment"}}],
    )
    assert payload.detected_bank is None
    assert payload.pre_extracted_rows is not None


if __name__ == "__main__":
    assert_old_payload_accepted()
    assert_v2_payload_accepted()
    assert_bank_detection_payload_accepted()
    assert_unknown_bank_is_distinct_from_an_older_frontend()
    assert_old_payload_still_accepted_without_bank_fields()
    print("request_model_check: ok")
