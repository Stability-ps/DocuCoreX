import io
import json
import logging
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import fitz
import pdfplumber
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from pydantic import BaseModel
from supabase import Client, create_client
from engine.bootstrap import register_default_parsers
from engine.registry import BankRegistry


app = FastAPI(title="DocuCoreX Accounting Worker")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("docucorex.accounting_worker")
WORKER_PARSER_VERSION = "fnb_business_v1"
WORKER_BUILD_FALLBACK = "local-dev"
DEFAULT_AI_MODEL = "gpt-4o-mini"
AI_CLASSIFICATION_CACHE: dict[str, dict[str, Any]] = {}
AI_CLASSIFICATION_BATCH_SIZE = 30
ACCOUNTING_REPORT_DISCLAIMER = (
    "Draft management report generated from bank-statement data only. "
    "This is not a final IFRS or Companies Act financial statement and requires accountant review."
)
MONEY_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])(?P<negative>-)?(?:R\s*)?(?P<bracket>\()?(?P<amount>(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?:\))?\s*(?P<suffix>Cr|CR|Dr|DR)?(?!\d)",
    re.IGNORECASE,
)
MAX_DATABASE_AMOUNT = Decimal("999999999999.99")
CENT = Decimal("0.01")

register_default_parsers()


def log_event(event: str, **fields: Any) -> None:
    logger.info(json.dumps({"event": event, **fields}, default=str))


def log_warning(event: str, **fields: Any) -> None:
    logger.warning(json.dumps({"event": event, **fields}, default=str))


def log_exception(event: str, **fields: Any) -> None:
    logger.exception(json.dumps({"event": event, **fields}, default=str))


def git_commit_fallback() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return WORKER_BUILD_FALLBACK


def worker_version() -> dict[str, str]:
    commit = (
        os.getenv("RENDER_GIT_COMMIT")
        or os.getenv("GIT_COMMIT")
        or os.getenv("COMMIT_SHA")
        or os.getenv("VERCEL_GIT_COMMIT_SHA")
        or git_commit_fallback()
    )
    return {
        "status": "ok",
        "service": os.getenv("RENDER_SERVICE_NAME") or os.getenv("WORKER_SERVICE_NAME") or "accounting-worker",
        "parser_version": WORKER_PARSER_VERSION,
        "commit": commit,
        "render_service_id": os.getenv("RENDER_SERVICE_ID", ""),
        "render_service_name": os.getenv("RENDER_SERVICE_NAME", ""),
    }


def with_worker_version(payload: dict[str, Any]) -> dict[str, Any]:
    return {**payload, "worker": worker_version()}


class ProcessRequest(BaseModel):
    run_id: str
    workspace_id: str
    document_id: str | None = None
    processing_job_id: str | None = None
    storage_path: str
    # Optional hints from the Node extraction pipeline. When pre_extracted_text is
    # provided (from the selected parser: pdfjs/pdfplumber/ocr/hybrid) it is used
    # as the statement text; the original PDF remains the fallback.
    parser_method: str | None = None
    extraction_source: str | None = None
    ocr_used: bool | None = None
    pre_extracted_text: str | None = None
    extraction_debug: dict[str, Any] | None = None


class CombineRequest(BaseModel):
    workspace_id: str
    run_ids: list[str]
    combine_different_accounts: bool = False
    override_continuity: bool = False


class ParsedTransaction(BaseModel):
    transaction_date: str | None
    description: str
    debit_amount: float | None = None
    credit_amount: float | None = None
    running_balance: float | None = None
    bank_charge: bool = False
    account_category: str = "Uncategorised"
    vat_treatment: str = "review"
    supported_by_invoice: bool = False
    notes: str = ""
    confidence: float = 70
    review_status: str = "needs_review"
    source_page: int | None = None
    source_row: int | None = None
    raw_text: str | None = None


def get_supabase() -> Client:
    url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return create_client(url, key)


def fetch_classification_rules(supabase: Client, workspace_id: str) -> list[dict[str, Any]]:
    try:
        response = (
            supabase.table("accounting_classification_rules")
            .select("merchant_key,account_category,vat_treatment,review_status,confidence,reason")
            .eq("workspace_id", workspace_id)
            .execute()
        )
        rules = response.data if isinstance(response.data, list) else []
        log_event("worker.classification_rules_loaded", workspace_id=workspace_id, count=len(rules))
        return rules
    except Exception as exc:
        log_warning("worker.classification_rules_unavailable", workspace_id=workspace_id, error=str(exc))
        return []


def apply_learned_classification_rules(transactions: list[ParsedTransaction], rules: list[dict[str, Any]]) -> int:
    if not rules:
        return 0
    sorted_rules = sorted(
        rules,
        key=lambda rule: len(str(rule.get("merchant_key") or "")),
        reverse=True,
    )
    applied = 0
    for transaction in transactions:
        key = normalize_merchant_key(transaction.description)
        if not key:
            continue
        matched_rule = next((rule for rule in sorted_rules if str(rule.get("merchant_key") or "") and str(rule.get("merchant_key")) in key), None)
        if not matched_rule:
            continue
        transaction.account_category = str(matched_rule.get("account_category") or transaction.account_category)
        transaction.vat_treatment = str(matched_rule.get("vat_treatment") or transaction.vat_treatment)
        transaction.review_status = str(matched_rule.get("review_status") or transaction.review_status)
        transaction.confidence = max(float(transaction.confidence or 0), float(matched_rule.get("confidence") or 94))
        applied += 1
    return applied


def verify_worker_token(authorization: str | None) -> None:
    expected = os.getenv("ACCOUNTING_WORKER_TOKEN")
    if not expected:
        return
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid worker token")


def parse_money(value: str | None) -> float | None:
    return decimal_to_float(parse_money_cell(value))


def decimal_to_float(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value.quantize(CENT, rounding=ROUND_HALF_UP))


def parse_money_cell(value: str | None) -> Decimal | None:
    if not value:
        return None
    matches = list(MONEY_TOKEN.finditer(value.replace("\u00a0", " ").strip()))
    if not matches:
        return None
    match = matches[-1]
    normalized = match.group("amount").replace(",", "").replace(" ", "")
    try:
        amount = Decimal(normalized)
    except Exception:
        return None
    if match.group("negative") or match.group("bracket") or (match.group("suffix") or "").lower() == "dr":
        amount = -amount
    if amount.copy_abs() > MAX_DATABASE_AMOUNT:
        log_warning("worker.amount_cell_out_of_bounds", raw=value, token=match.group(0), amount=str(amount))
        return None
    return amount


def parse_transaction_amount_cell(value: str | None) -> tuple[float | None, float | None] | None:
    amount = parse_money_cell(value)
    if amount is None:
        return None
    suffix = ""
    if value:
        matches = list(MONEY_TOKEN.finditer(value.replace("\u00a0", " ").strip()))
        suffix = (matches[-1].group("suffix") or "").lower() if matches else ""
    if suffix == "cr":
        return None, decimal_to_float(amount.copy_abs())
    return decimal_to_float(amount.copy_abs()), None


def looks_like_money(value: str | None) -> bool:
    if not value:
        return False
    return MONEY_TOKEN.search(value) is not None


def money_sign_hint(value: str | None) -> str | None:
    if not value:
        return None
    lowered = value.lower()
    if "cr" in lowered or "credit" in lowered or "+" in lowered:
        return "credit"
    if "dr" in lowered or "debit" in lowered or value.strip().startswith("-") or value.strip().endswith("-"):
        return "debit"
    return None


def parse_date(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def extract_text_with_pdfplumber(pdf_bytes: bytes) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
            tables = page.extract_tables() or []
            pages.append({"page": index, "text": text, "tables": tables})
    return pages


def extract_text_with_pymupdf(pdf_bytes: bytes) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    for index, page in enumerate(document, start=1):
        pages.append({"page": index, "text": page.get_text("text"), "tables": []})
    document.close()
    return pages


def extract_statement_text(pdf_bytes: bytes) -> list[dict[str, Any]]:
    pages = extract_text_with_pdfplumber(pdf_bytes)
    if sum(len(page["text"]) for page in pages) >= 250:
        return pages
    return extract_text_with_pymupdf(pdf_bytes)


def find_first(patterns: list[str], text: str) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1).strip()
    return None


# Words/patterns that identify an ADDRESS line. A company name must never be
# taken from a line matching any of these (fixes "ITALA PLACE" / "MOOIKLOOF"
# being used as the company name).
_ADDRESS_WORDS = {
    "STREET", "STR", "ROAD", "RD", "AVENUE", "AVE", "DRIVE", "DRV", "LANE",
    "CLOSE", "CRESCENT", "CRES", "BOULEVARD", "BLVD", "PLACE", "PARK", "ESTATE",
    "UNIT", "SUITE", "FLOOR", "BLOCK", "ERF", "PLOT", "HIGHWAY", "RIDGE", "VIEW",
    "HEIGHTS", "GARDENS", "VILLAGE", "MEWS", "POSTNET", "BAG",
}
# Common SA suburbs/cities that appear on statements and must not be used as a name.
_ADDRESS_PLACES = {
    "MOOIKLOOF", "PRETORIA", "JOHANNESBURG", "CENTURION", "SANDTON", "MIDRAND",
    "CAPE TOWN", "DURBAN", "BLOEMFONTEIN", "GQEBERHA", "PORT ELIZABETH",
    "POLOKWANE", "MBOMBELA", "NELSPRUIT", "KIMBERLEY", "EAST LONDON",
    "PIETERMARITZBURG", "RANDBURG", "ROODEPOORT", "BENONI", "BOKSBURG",
    "GERMISTON", "SOWETO", "WATERFALL", "FOURWAYS", "BRYANSTON", "ROSEBANK",
}
# Legal-entity suffixes that strongly indicate a real company name.
_COMPANY_SUFFIX = re.compile(
    r"\b(\(?PTY\)?\s*LTD|PTY\s*LTD|LTD|CC|INC|LLP|NPC|SOC\s*LTD|TRUST|BK|BPK|EDMS\s*BPK)\b",
    flags=re.IGNORECASE,
)
_BANK_NAMES = {"FNB", "FIRST NATIONAL BANK", "ABSA", "NEDBANK", "STANDARD BANK", "CAPITEC", "INVESTEC", "TYMEBANK"}


def looks_like_address(text: str) -> bool:
    if not text:
        return True
    upper = text.upper().strip()
    # Standalone postal code, or a line starting with a street number.
    if re.fullmatch(r"\d{4}", upper):
        return True
    if re.match(r"^\d+\s", upper) and not _COMPANY_SUFFIX.search(upper):
        return True
    if "P O BOX" in upper or "PO BOX" in upper or "PRIVATE BAG" in upper:
        return True
    tokens = set(re.findall(r"[A-Z]+", upper))
    if tokens & _ADDRESS_WORDS:
        return True
    for place in _ADDRESS_PLACES:
        if place in upper:
            return True
    return False


def detect_company_name(full_text: str) -> str | None:
    """Detect the account holder / company. Priority:
    1) explicit labelled fields, 2) a line carrying a legal suffix,
    3) the first business-looking line — always rejecting address lines.
    """
    # 1) Explicit labels.
    labelled = find_first([
        r"Account\s*Holder\s*[:\-]?\s*(.+)",
        r"Account\s*Name\s*[:\-]?\s*(.+)",
        r"Customer\s*Name\s*[:\-]?\s*(.+)",
        r"Client\s*Name\s*[:\-]?\s*(.+)",
    ], full_text)
    if labelled:
        candidate = labelled.strip()
        if candidate and not looks_like_address(candidate):
            return candidate

    lines = [line.strip() for line in full_text.splitlines() if line.strip()]
    header = lines[:25]

    # 2) A line with a legal-entity suffix. Truncate at the suffix so trailing
    #    bank header text (branch code, VAT reg, account number) is dropped.
    for line in header:
        if len(line) < 4 or len(line) > 120:
            continue
        if line.upper() in _BANK_NAMES:
            continue
        if _COMPANY_SUFFIX.search(line) and not looks_like_address(line):
            cleaned = clean_company_name(line)
            if cleaned and not looks_like_address(cleaned):
                return cleaned

    # 3) First business-looking uppercase line before the address block.
    for line in header:
        stripped = clean_company_name(line.strip(" *:-"))
        if len(stripped) < 4 or len(stripped) > 60:
            continue
        upper = stripped.upper()
        if upper in _BANK_NAMES or upper in {"STATEMENT", "BANK STATEMENT", "TAX INVOICE"}:
            continue
        if re.search(r"\d{2}[/ ]\d{2}", stripped):  # looks like a date
            continue
        if looks_like_address(stripped):
            continue
        if re.search(r"[A-Za-z]{3,}", stripped) and re.match(r"^[A-Z0-9 &().,'/-]+$", stripped):
            return re.sub(r"\s+", " ", stripped).strip()

    return None


# Bank-header tokens that must never be part of a company name.
_BANK_META_TAIL = re.compile(
    r"\b(UNIVERSAL\s+BRANCH\s+CODE|BRANCH\s+CODE|BRANCH|VAT\s+(?:REG|REGISTRATION)"
    r"|ACCOUNT\s+(?:NUMBER|NO)|SWIFT|BIC|STATEMENT\s+(?:NO|NUMBER|DATE|PERIOD))\b",
    flags=re.IGNORECASE,
)


def clean_company_name(text: str) -> str:
    """Return just the legal entity name — never trailing bank header text such
    as 'Universal Branch Code 250655'."""
    name = re.sub(r"\s+", " ", text).strip(" *:-,")
    suffix = _COMPANY_SUFFIX.search(name)
    if suffix:
        # Keep up to and including the first legal suffix, drop the rest.
        name = name[: suffix.end()].strip(" *:-,")
    else:
        tail = _BANK_META_TAIL.search(name)
        if tail:
            name = name[: tail.start()].strip(" *:-,")
    return name


def detect_account_number(full_text: str) -> str | None:
    """FNB prints e.g. 'Gold Business Account : 63041819765'. Account numbers are
    8+ digits (FNB uses 11) — never a short reference/delivery/branch number."""
    labelled = find_first([
        r"(?:Cheque|Gold|Platinum|Business|Savings|Current|Enterprise|Easy|Core)\s+Account\s*[:#\-]?\s*(\d[\d\s]{7,})",
        r"Account\s*(?:Number|No\.?)\s*[:#\-]?\s*(\d[\d\s]{7,})",
    ], full_text)
    if labelled:
        digits = re.sub(r"\D", "", labelled)
        if 8 <= len(digits) <= 16:
            return digits
    match = re.search(r"Account[^\d]{0,25}(\d{10,13})", full_text, flags=re.IGNORECASE)
    if match:
        return match.group(1)
    return None


def parse_metadata(full_text: str) -> dict[str, Any]:
    # Detect the account holder / company from the statement itself, never from
    # an address line and never hardcoded.
    company_name = detect_company_name(full_text)

    statement_number = find_first([
        r"Statement\s*(?:Number|No\.?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-/]{2,})",
    ], full_text)
    statement_date = find_first([
        r"Statement\s*Date\s*[:\-]?\s*(\d{1,2}[\/ ](?:\d{1,2}|[A-Za-z]{3,9})[\/ ]\d{2,4})",
    ], full_text)

    period = re.search(
        r"(?:Statement\s*Period|Period)\s*[:\-]?\s*(\d{1,2}[\/ ](?:\d{1,2}|[A-Za-z]{3,9})[\/ ]\d{2,4})\s*(?:to|-)\s*(\d{1,2}[\/ ](?:\d{1,2}|[A-Za-z]{3,9})[\/ ]\d{2,4})",
        full_text,
        flags=re.IGNORECASE,
    )

    opening_balance = find_first([
        r"Opening\s*Balance\s*[:\-]?\s*R?\s*([0-9,.\-() ]+)",
        r"Balance\s*Brought\s*Forward\s*[:\-]?\s*R?\s*([0-9,.\-() ]+)",
    ], full_text)
    closing_balance = find_first([
        r"Closing\s*Balance\s*[:\-]?\s*R?\s*([0-9,.\-() ]+)",
        r"Balance\s*Carried\s*Forward\s*[:\-]?\s*R?\s*([0-9,.\-() ]+)",
    ], full_text)

    # Statement summary block — the statement's OWN declared totals. These are the
    # ground truth used to validate the extraction (any bank, any statement).
    credit_txn_count = find_first([r"Credit\s*[Tt]ransactions?\s*[:\-]?\s*(\d+)"], full_text)
    debit_txn_count = find_first([r"Debit\s*[Tt]ransactions?\s*[:\-]?\s*(\d+)"], full_text)
    expected_count = None
    if credit_txn_count is not None and debit_txn_count is not None:
        expected_count = int(credit_txn_count) + int(debit_txn_count)

    # Declared turnover totals (e.g. "Credit Transactions 15 419,700.00").
    credit_total = find_first([
        r"Credit\s*[Tt]ransactions?\s*\d+\s+R?\s*([0-9,]+\.\d{2})",
        r"Total\s*Credits?\s*[:\-]?\s*R?\s*([0-9,]+\.\d{2})",
    ], full_text)
    debit_total = find_first([
        r"Debit\s*[Tt]ransactions?\s*\d+\s+R?\s*([0-9,]+\.\d{2})",
        r"Total\s*Debits?\s*[:\-]?\s*R?\s*([0-9,]+\.\d{2})",
    ], full_text)

    # Declared bank fee / VAT summary (do NOT treat cash deposit *amounts* as fees).
    service_fees = find_first([r"Service\s*Fees?\s*[:\-]?\s*R?\s*([0-9,]+\.\d{2})"], full_text)
    cash_deposit_fees = find_first([r"Cash\s*Deposit\s*Fees?\s*[:\-]?\s*R?\s*([0-9,]+\.\d{2})"], full_text)
    total_vat = find_first([
        r"Total\s*VAT\s*[:\-]?\s*R?\s*([0-9,]+\.\d{2})",
        r"VAT\s*Charged\s*[:\-]?\s*R?\s*([0-9,]+\.\d{2})",
    ], full_text)

    return {
        "company_name": company_name,
        "account_number": detect_account_number(full_text),
        "statement_number": statement_number.strip() if statement_number else None,
        "statement_date": parse_date(statement_date) if statement_date else None,
        "statement_period_start": parse_date(period.group(1)) if period else None,
        "statement_period_end": parse_date(period.group(2)) if period else None,
        "opening_balance": parse_money(opening_balance),
        "closing_balance": parse_money(closing_balance),
        "expected_credit_count": int(credit_txn_count) if credit_txn_count is not None else None,
        "expected_debit_count": int(debit_txn_count) if debit_txn_count is not None else None,
        "expected_transaction_count": expected_count,
        "declared_credit_total": parse_money(credit_total),
        "declared_debit_total": parse_money(debit_total),
        "declared_service_fees": parse_money(service_fees),
        "declared_cash_deposit_fees": parse_money(cash_deposit_fees),
        "declared_total_vat": parse_money(total_vat),
    }


TRANSACTION_LINE = re.compile(
    r"^(?P<date>\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\s+"
    r"(?P<description>.+?)\s+"
    r"(?P<amount1>-?R?\s?[0-9][0-9, ]*\.\d{2}-?)"
    r"(?:\s+(?P<amount2>-?R?\s?[0-9][0-9, ]*\.\d{2}-?))?"
    r"(?:\s+(?P<balance>-?R?\s?[0-9][0-9, ]*\.\d{2}-?))?$",
    flags=re.IGNORECASE,
)

LOOSE_DATE = re.compile(r"(?P<date>\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?)")
LOOSE_MONEY = re.compile(r"(?:R\s*)?-?\(?\d[\d,\s]*\.\d{2}\)?-?")
FNB_PAGE_ARTIFACT = re.compile(
    r"\b(?:Page\s+\d+\s+of\s+\d+|Delivery\s+Method|Branch\s+Number|Account\s+Number|"
    r"PLATINUM\s+BUSINESS\s+ACCOUNT|Accrued\s+Date\s+Description\s+Amount\s+Balance\s+Bank\s+Charges|"
    r"DDA\s+[A-Z0-9/ ]{8,})\b",
    re.IGNORECASE,
)


def strip_fnb_page_artifacts(line: str) -> str:
    cleaned = re.sub(r"\s+", " ", line).strip()
    match = FNB_PAGE_ARTIFACT.search(cleaned)
    if match:
        cleaned = cleaned[: match.start()].strip()
    return cleaned


def is_fnb_page_artifact(line: str) -> bool:
    cleaned = re.sub(r"\s+", " ", line).strip()
    if not cleaned:
        return True
    lowered = cleaned.lower()
    artifact_prefixes = (
        "page ",
        "delivery method",
        "branch number",
        "account number",
        "platinum business account",
        "accrued date description amount balance bank charges",
        "date dda ",
    )
    return any(lowered.startswith(prefix) for prefix in artifact_prefixes) or bool(FNB_PAGE_ARTIFACT.fullmatch(cleaned))


def normalize_transaction_date(raw_date: str, metadata: dict[str, Any]) -> str | None:
    parsed = parse_date(raw_date)
    if parsed:
        return parsed
    end = metadata.get("statement_period_end")
    year = date.today().year
    if end:
        year = datetime.fromisoformat(end).year
    if re.search(r"[A-Za-z]", raw_date):
        return parse_date(f"{raw_date} {year}")
    return parse_date(f"{raw_date}/{year}")


def classify_transaction(description: str, debit: float | None, credit: float | None) -> tuple[str, str, bool, float]:
    text = description.lower()
    if debit and debit > 0 and looks_like_business_supplier_payment(text):
        return "Supplier Payments", "review", False, 88
    # Ordered deterministic rules — most specific first. VAT is kept conservative
    # ("review") wherever an invoice is needed, but the account is still assigned
    # so transactions do not fall through to "Uncategorised".
    rules: list[tuple[tuple[str, ...], str, str, bool, float]] = [
        # Bank charges & fees ONLY (VAT-standard, input VAT applies). NOTE: a bare
        # "cash deposit" is an inflow, not a fee — only the "cash deposit FEE" line
        # is a bank charge.
        (("service fee", "#service fees", "# service fees", "monthly account fee", "#monthly account fee",
          "byc debit", "accrued bank charge", "cash deposit fee", "#cash deposit fee", "cash handling fee",
          "admin fee", "card fee", "pos fee", "excess item fee", "excess item", "item fee", "unpaid item",
          "excess fee", "declined fee", "penalty fee"), "Bank Charges", "standard", True, 97),
        # Interest
        (("credit interest", "interest received"), "Interest Income", "exempt", False, 90),
        (("debit interest", "interest charged", "overdraft interest"), "Finance Costs", "exempt", False, 88),
        # Cash deposits (the deposit amount is an inflow, NOT a bank charge)
        (("adt cash deposit", "cash deposit woodland", "cash deposit", "cash dep "),
         "Cash Deposits / Revenue", "review", False, 78),
        # Communication (prepaid / airtime / data)
        (("prepaid", "airtime", "data bundle", "fnb app prepaid", "vodacom", "mtn ", "telkom", "cell c", "rain "),
         "Telephone / Internet / Communication", "review", False, 84),
        # Inter-account / own transfers
        (("fnb app transfer to savings", "fnb app transfer from", "transfer to me", "transfer from",
          "transfer to savings", "scheduled payment to savings", "money maximizer savings", "inter-account", "internal transfer", "own account"),
         "Inter-account Transfer", "out_of_scope", False, 92),
        # Home loans / credit card funding — balance sheet, not P&L.
        (("scheduled payment to home loan", "home loan payment", "transfer to home loan", "transfer to credit card", "fnb app transfer to credit card"),
         "Loan / Liability", "out_of_scope", False, 90),
        # Explicit director / drawings keywords (generic).
        (("drawings", "director loan", "director's loan", "owner draw"),
         "Director Loan / Drawings", "out_of_scope", False, 82),
        # SARS / tax — suspense/liability, NEVER revenue. Excluded from P&L.
        (("tax deposit", "sars", "efiling", "paye", "vat201", "vat 201", "provisional tax"),
         "SARS / Tax Suspense", "review", False, 82),
        # Insurance / funeral debit orders
        (("discovery account", "discovery insure", "discovery insurance", "discovery health", "insurance premium", "funeral", "fnbfuneral",
          "life cover", "outsurance", "santam", "old mutual"), "Insurance Expense", "exempt", False, 85),
        # Salaries / payroll
        (("salary", "payroll", "wages", "nanny", "care giver", "caregiver", "brilliant care giver",
          "ana care giver", "waterfall salary", "sunfield sureka reddy"), "Salaries & Wages", "out_of_scope", False, 90),
        # Medical aid / employee medical deductions
        (("medical aid", "med aid", "medshield", "momentum health", "discovery health", "bonitas"),
         "Salaries & Wages", "out_of_scope", False, 90),
        # Loans — balance-sheet liability, excluded from P&L (interest is separate).
        (("loan repayment", "loan installment", "loan instalment", "vehicle finance", "wesbank", "loan"),
         "Loan / Liability", "out_of_scope", False, 80),
        # Road use / toll operators
        (("toll", "sanral", "n3tc", "bakwena", "tracn4", "toll gate"),
         "Road Tolls", "standard", False, 88),
        # Refunds
        (("refund", "reversal"), "Refund / Suspense", "review", False, 74),
        # Levies
        (("levy", "levies", "body corporate", "hoa ", "h/o/a", "emporers ridge"), "Levies", "review", False, 84),
        # Software / IT
        (("google chatgpt", "chatgpt", "openai", "microsoft", "office365", "microsoft 365", "adobe",
          "subscription", "saas", "aws ", "amazon web services", "google cloud", "google workspace",
          "sage sa", "sage acc", "sage accounting", "pos purchase sage"),
         "Software Subscriptions", "standard", False, 84),
        (("google xiaomi home", "xiaomi home", "google play"), "Software / IT", "review", False, 82),
        # Courier / delivery
        (("dhl", "paygate*dhl", "paygate dhl", "courier", "aramex", "the courier guy", "courier guy", "postnet"), "Courier / Delivery", "standard", False, 84),
        # Meals / entertainment
        (("uber eats", "mr d food", "mr d", "restaurant", "checkers sixty60", "woolworths"), "Staff Welfare / Meals / Entertainment", "review", False, 80),
        (("emporers ridge utili", "emporers ridge utility", "utility payment", "utilities"), "Utilities", "standard", False, 84),
        # Government / tender receipts. These are customer receipts for work or
        # services supplied, not welfare/meal merchants and not generic income.
        (("magtape credit 047-gp hea", "gp hea-", "gauteng health", "department of health", "dept of health", "health department"),
         "Sales / Revenue", "standard", False, 94),
        # Personal-looking or unclear suppliers should stay in review instead of
        # being upgraded to normal operating expenses.
        (("senses spa", "adore photography", "sloppy kisses", "puppy classes", "prayer shop"),
         "Review Required", "review", False, 62),
        # Recurring debit orders and named suppliers that are operational but
        # still need invoice/supporting detail before VAT is claimed.
        (("netcash", "stratum netcash", "magtape debit stratum", "disc prem", "magtape debit disc prem"),
         "Operating Expenses", "review", False, 76),
        (("acapolite accounting", "bookkeeping", "audit fee", "tax practitioner"),
         "Accounting / Professional Fees", "standard", False, 88),
        (("rmsp trading", "stalitrex", "nms enterprises", "nms enterprises 5290b"),
         "Supplier Payments", "review", False, 86),
        (("jc industries", "bambhanani enterpris", "first works", "fabric and leather", "world focus", "kenny s intermedia"),
         "Operating Expenses", "review", False, 76),
        (("samsung electronics", "global-e", "global e"), "Software / IT", "review", False, 82),
        (("sunnydale pharm", "khumbu hair", "raquel hair", "hair stuff", "hair health"),
         "Staff Welfare / Meals / Entertainment", "review", False, 72),
        # Fuel / motor
        (("fuel", "petrol", "diesel", "garage", "engen", "shell", "bp ", "sasol", "total ", "caltex", "volvo"),
         "Motor Vehicle Expenses", "standard", False, 84),
        # Freight / logistics suppliers and customer references seen on FNB freight
        # statements (kept direction-safe: receipts stay income, payments stay opex).
        (("afrigreen", "freight aces", "millenium trans", "pablo logistics", "kavi comm", "orca freight", "arca freight"),
         "Sales / Revenue" if credit and credit > 0 else "Operating Expenses", "standard", False, 87),
        # Pharmacy / medical retail
        (("pharmacy", "chemist", "dis-chem", "clicks"), "Medical Expenses", "review", False, 82),
        # Sales / income (inbound payments)
        (("fnb ob pmt", "payment from", "rtc credit", "cash deposit received", "eft credit", "customer receipt", "customer payment", "immediate payment received"),
         "Sales / Revenue", "standard", False, 90),
    ]
    for needles, category, vat, bank_charge, confidence in rules:
        if any(needle in text for needle in needles):
            return category, vat, bank_charge, confidence

    # Generic person-to-person / instant payments (any name, never hardcoded).
    # A payment to a NAME is a related-party / drawings movement; a payment to a
    # NUMBER/reference is a suspense item. Both are review, never P&L expense.
    person_markers = (
        "app payment to", "app rtc pmt to", "rtc pmt to", "payshap", "send money to",
        "e wallet", "ewallet", "instant money", "cardless", "app transfer to ",
    )
    if any(marker in text for marker in person_markers):
        tail = text.rsplit(" to ", 1)[-1] if " to " in text else text
        business_hints = (
            "diesel", "volvo", "toll", "sanral", "salary", "medical", "aid", "insurance",
            "loan", "freight", "afrigreen", "pharmacy", "chemist", "dis-chem", "clicks",
            "engen", "shell", "sasol", "caltex", "customer", "invoice", "inv",
        )
        if looks_like_business_supplier_payment(tail):
            return "Supplier Payments", "review", False, 88
        if any(hint in tail for hint in business_hints):
            if credit and credit > 0:
                return "Sales / Revenue", "standard", False, 82
            if debit and debit > 0:
                return "Operating Expenses", "review", False, 78
        if re.search(r"\d{5,}", tail) and not re.search(r"[a-z]{3,}", tail):
            return "Suspense / Review Required", "review", False, 60
        return "Related Party / Drawings", "out_of_scope", False, 68

    # Direction-based fallbacks — conservative: never assume an unknown debit is a
    # normal operating expense. Unknown outflows are suspense/review.
    if credit and credit > 0:
        return "Revenue Review", "review", False, 66
    if debit and debit > 0:
        return "Suspense / Review Required", "review", False, 55
    return "Uncategorised", "review", False, 50


def looks_like_business_supplier_payment(text: str) -> bool:
    lowered = text.lower()
    return any(token in lowered for token in (
        "msi industries",
        "industries",
        "trading",
        "enterprises",
        "enterprise",
        "invoice",
        " inv",
        "inv0",
        "inv1",
        " inv-",
        "interiors",
        "first works",
        "jc industries",
        "fabric and leather",
        "midway",
        "world focus",
        "bambhanani",
        "supplier",
        "services",
    ))


def is_staff_welfare_merchant(text: str) -> bool:
    lowered = text.lower()
    return any(token in lowered for token in (
        "uber eats",
        "mr d food",
        "mr d",
        "restaurant",
        "checkers",
        "woolworths",
        "meat",
        "food",
        "meal",
        "catering",
        "coffee",
        "spa",
        "puppy",
        "sloppy kisses",
        "photography",
        "netflorist",
        "hair",
        "with love",
        "gift",
    ))


def normalize_merchant_key(description: str) -> str:
    lowered = description.lower()
    lowered = re.sub(r"\b\d{1,2}\s+[a-z]{3,9}\b", " ", lowered)
    lowered = re.sub(r"\b(?:inv|invoice|ref|rmsp|m)\s*[\w-]+\b", " ", lowered)
    lowered = re.sub(r"\b\d{3,}\b", " ", lowered)
    lowered = re.sub(r"\d+[.,]\d{2}\s*(cr|dr)?", " ", lowered)
    lowered = re.sub(r"\b(pty|ltd|business account)\b", " ", lowered)
    lowered = re.sub(r"[^a-z#* ]+", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()[:160]


def classification_reason(category: str, description: str, confidence: float) -> tuple[str, str]:
    merchant = normalize_merchant_key(description) or description[:80]
    if confidence >= 95:
        reason = f"Known merchant pattern matched: {merchant}."
    elif confidence >= 80:
        reason = f"Recurring merchant pattern matched with review-safe confidence: {merchant}."
    else:
        reason = f"Unclear merchant or VAT treatment for: {merchant}."
    explanation = f"Classified as {category} using merchant pattern, transaction direction, amount context and VAT rules. Company names are not used as supplier evidence."
    return reason, explanation


def is_noise_transaction(description: str) -> bool:
    lowered = description.lower()
    noise = (
        "opening balance",
        "closing balance",
        "balance brought forward",
        "balance carried forward",
        "date description",
        "transaction date",
        "statement",
        "page ",
    )
    return any(item in lowered for item in noise)


def build_transaction(
    raw_date: str,
    description: str,
    debit: float | None,
    credit: float | None,
    balance: float | None,
    metadata: dict[str, Any],
    page_number: int | None,
    raw_text: str,
    base_confidence: float,
) -> ParsedTransaction | None:
    normalized_description = re.sub(r"\s+", " ", description).strip(" -|")
    if is_noise_transaction(normalized_description):
        return None
    if not normalized_description:
        # FNB "#" fee rows sometimes lose their description in text extraction,
        # leaving only date + amount + balance. Keep the row (it still moves the
        # balance) with a placeholder rather than dropping it and failing recon.
        normalized_description = "Unlabelled transaction"

    for label, amount in (("debit", debit), ("credit", credit), ("balance", balance)):
        if amount is not None and Decimal(str(amount)).copy_abs() > MAX_DATABASE_AMOUNT:
            log_warning(
                "worker.transaction_amount_rejected",
                field=label,
                amount=amount,
                raw_text=raw_text,
                description=normalized_description,
            )
            return None

    transaction_date = normalize_transaction_date(raw_date, metadata)
    if not transaction_date:
        return None

    if debit is None and credit is None:
        return None

    category, vat, bank_charge, rule_confidence = classify_transaction(normalized_description, debit, credit)
    confidence = min(99, rule_confidence)
    review_status = "ready" if confidence >= 80 and vat != "review" and category != "Review Required" else "needs_review"

    return ParsedTransaction(
        transaction_date=transaction_date,
        description=normalized_description,
        debit_amount=debit,
        credit_amount=credit,
        running_balance=balance,
        bank_charge=bank_charge,
        account_category=category,
        vat_treatment=vat,
        supported_by_invoice=False,
        confidence=confidence,
        review_status=review_status,
        source_page=page_number,
        raw_text=raw_text,
    )


def transaction_section_lines(full_text: str) -> list[str]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in full_text.splitlines()]
    in_section = False
    seen_transaction = False
    awaiting_section_reopen = False
    section: list[str] = []

    for line in lines:
        line = strip_fnb_page_artifacts(line)
        if is_fnb_page_artifact(line):
            continue
        lowered = line.lower()
        if awaiting_section_reopen:
            if "transactions in rand" in lowered:
                awaiting_section_reopen = False
                in_section = True
                continue
            if "turnover for statement period" in lowered:
                break
            if "balance brought forward" in lowered or "balance carried forward" in lowered:
                continue
            # If the next meaningful line after an intermediate closing line is
            # another dated transaction row, keep parsing the same section.
            if LOOSE_DATE.match(line):
                awaiting_section_reopen = False
                in_section = True
            else:
                # Footer / summary content after the final closing balance.
                break
        # Section start: the "Transactions in RAND (ZAR)" heading, with or without
        # the account number / colon (e.g. "Transactions in RAND (ZAR) : 62905786151").
        # It repeats on every page — re-entering the section is harmless. "(ZAR)"
        # may wrap onto its own line, so it is not required on the heading line.
        if "transactions in rand" in lowered:
            in_section = True
            awaiting_section_reopen = False
            continue
        if not in_section:
            continue
        # Section end: the true statement end only. A summary "Closing Balance" or a
        # per-page "Balance Brought/Carried Forward" must NOT end it early. Some
        # scanned/OCR layouts emit "Closing Balance" between repeated page headers.
        # Keep parsing until the statement turnover/summary block starts.
        if "turnover for statement period" in lowered:
            break
        if "closing balance" in lowered and seen_transaction:
            awaiting_section_reopen = True
            continue
        if line:
            section.append(line)
            if LOOSE_DATE.match(line):
                seen_transaction = True

    return section


def transaction_candidate_lines(full_text: str) -> list[str]:
    candidates: list[str] = []
    current = ""
    last_date = ""

    def append_candidate(candidate: str) -> None:
        for item in split_compound_candidate_line(candidate):
            if item:
                candidates.append(item)

    for line in transaction_section_lines(full_text):
        line = strip_fnb_page_artifacts(line)
        if is_fnb_page_artifact(line):
            if current:
                append_candidate(current.strip())
                current = ""
            continue
        date_match = LOOSE_DATE.match(line)
        if date_match:
            if current:
                append_candidate(current.strip())
            current = line
            last_date = date_match.group("date")
            continue

        # FNB prints the transaction date only once per date group, so rows after
        # the first in a group (debit orders, app / RTC payments, fee lines) print
        # WITHOUT a leading date. If such a continuation line carries its OWN
        # described money amount it is a separate movement, not a wrapped
        # description — start a new candidate for it inheriting the group's date so
        # it is not swallowed into the previous row (which drops the movement and
        # breaks reconciliation). A bare balance token (no descriptive text) is
        # treated as a wrap and appended.
        if last_date and _is_grouped_movement_line(line):
            if current:
                append_candidate(current.strip())
            current = f"{last_date} {line}".strip()
            continue

        if current:
            current = f"{current} {line}".strip()

    if current:
        append_candidate(current.strip())

    return candidates


def split_compound_candidate_line(line: str) -> list[str]:
    matches = list(LOOSE_DATE.finditer(line))
    if len(matches) <= 1:
        return [line.strip()]

    parts: list[str] = []
    start = 0
    for match in matches[1:]:
        prefix = line[start:match.start()].strip()
        suffix = line[match.start():].strip()
        if prefix and MONEY_TOKEN.search(prefix) and MONEY_TOKEN.search(suffix):
            parts.append(prefix)
            start = match.start()

    tail = line[start:].strip()
    if tail:
        parts.append(tail)
    return parts or [line.strip()]


def _is_grouped_movement_line(line: str) -> bool:
    """A dateless continuation line that is itself a movement: it carries a money
    token preceded by descriptive text (letters). Excludes lone balance carries."""
    money = MONEY_TOKEN.search(line)
    if not money:
        return False
    lead = line[: money.start()]
    return bool(re.search(r"[A-Za-z]", lead))


def parse_fnb_transaction_line(line: str, metadata: dict[str, Any], base_confidence: float = 96) -> ParsedTransaction | None:
    line = strip_fnb_page_artifacts(line)
    date_match = LOOSE_DATE.match(line)
    if not date_match:
        return None

    matches = list(MONEY_TOKEN.finditer(line))
    if len(matches) < 2:
        return None

    charge_match = None
    balance_match = matches[-1]
    amount_match = matches[-2]

    if len(matches) >= 3 and not (matches[-1].group("suffix") or "").lower() and (matches[-2].group("suffix") or "").lower() in {"cr", "dr"}:
        charge_match = matches[-1]
        balance_match = matches[-2]
        amount_match = matches[-3]

    balance_suffix = (balance_match.group("suffix") or "").lower()
    if balance_suffix not in {"cr", "dr"}:
        return None

    amount = parse_money_cell(amount_match.group(0))
    balance = parse_money_cell(balance_match.group(0))
    charge_amount = parse_money_cell(charge_match.group(0)) if charge_match else None
    if amount is None or balance is None:
        return None

    amount_suffix = (amount_match.group("suffix") or "").lower()
    debit = None
    credit = None
    if amount_suffix == "cr":
        credit = decimal_to_float(amount.copy_abs())
    else:
        debit = decimal_to_float(amount.copy_abs())

    description = line[date_match.end():amount_match.start()].strip()
    transaction = build_transaction(
        date_match.group("date"),
        description,
        debit,
        credit,
        decimal_to_float(balance),
        metadata,
        None,
        line,
        base_confidence,
    )
    if transaction and charge_amount is not None and charge_amount != 0:
        transaction.notes = f"Accrued bank charges: {charge_amount.copy_abs().quantize(CENT)}"
    return transaction


def parse_amount_balance_line(line: str, metadata: dict[str, Any]) -> ParsedTransaction | None:
    """Capture a dated row that prints an amount AND a running balance but with NO
    Cr/Dr suffix on the balance (e.g. Internal Debit Order / FnbFuneral and "#"
    fee rows, often when the account is overdrawn so FNB prints the balance
    magnitude without "Cr"). The strict parser requires the suffix and drops these.

    Direction comes from the AMOUNT, never the balance magnitude: FNB marks credits
    with "Cr" on the amount, so an unsuffixed amount is a DEBIT. A Dr balance is
    printed as a positive number, so the running-balance value must NOT be used to
    infer direction (that flipped the R696.30 debit into a credit)."""
    line = strip_fnb_page_artifacts(line)
    date_match = LOOSE_DATE.match(line)
    if not date_match:
        return None
    matches = list(MONEY_TOKEN.finditer(line))
    if len(matches) != 2:
        return None
    amount_match, balance_match = matches[0], matches[1]
    amount = parse_money_cell(amount_match.group(0))
    balance = parse_money_cell(balance_match.group(0))
    if amount is None or balance is None or amount == 0:
        return None

    debit = credit = None
    if (amount_match.group("suffix") or "").lower() == "cr":
        credit = decimal_to_float(amount.copy_abs())
    else:
        debit = decimal_to_float(amount.copy_abs())

    # Sign the running balance: no "Cr" with a "Dr" suffix means an overdrawn
    # (negative) balance. Direction above does not depend on this.
    signed_balance = balance.copy_abs()
    if (balance_match.group("suffix") or "").lower() == "dr":
        signed_balance = -balance.copy_abs()

    description = line[date_match.end():amount_match.start()].strip()
    return build_transaction(
        date_match.group("date"), description, debit, credit, decimal_to_float(signed_balance), metadata, None, line, 84
    )


def parse_fnb_section_transactions(full_text: str, metadata: dict[str, Any]) -> list[ParsedTransaction]:
    transactions: list[ParsedTransaction] = []

    for line in transaction_candidate_lines(full_text):
        transaction = parse_fnb_transaction_line(line, metadata)
        if transaction:
            transactions.append(transaction)
            continue
        # Fallback: some rows (debit orders, app payments, RTC transfers) print
        # the amount without a running balance, so the strict two-token parser
        # rejects them and the statement fails to reconcile. Capture a dated line
        # that carries exactly one money token as a single-sided movement.
        fallback = parse_single_amount_line(line, metadata)
        if fallback:
            transactions.append(fallback)
            continue
        # Fallback: a dated row with amount + running balance but NO Cr/Dr suffix
        # (Internal Debit Order / FnbFuneral / "#" fee rows, common when the
        # account is overdrawn). Direction comes from the amount, not the balance.
        balance_row = parse_amount_balance_line(line, metadata)
        if balance_row:
            transactions.append(balance_row)

    return transactions


def parse_single_amount_line(line: str, metadata: dict[str, Any]) -> ParsedTransaction | None:
    line = strip_fnb_page_artifacts(line)
    date_match = LOOSE_DATE.match(line)
    if not date_match:
        return None
    matches = list(MONEY_TOKEN.finditer(line))
    if len(matches) != 1:
        return None
    amount_match = matches[0]
    amount = parse_money_cell(amount_match.group(0))
    if amount is None or amount == 0:
        return None
    suffix = (amount_match.group("suffix") or "").lower()
    debit = credit = None
    if suffix == "cr":
        credit = decimal_to_float(amount.copy_abs())
    else:
        debit = decimal_to_float(amount.copy_abs())
    description = line[date_match.end():amount_match.start()].strip()
    # Balance is unknown for these rows — leave it None so reconciliation totals
    # still include the movement without asserting a false running balance.
    return build_transaction(
        date_match.group("date"), description, debit, credit, None, metadata, None, line, 74
    )


# FNB prints accrued bank charges as "#"-prefixed lines. When such a line carries
# ONLY the fee amount and no running balance (e.g. "24 Mar # Cash Deposit Fee
# 599.44"), the strict transaction parser drops it. Lines that DO carry a balance
# are already handled by the section/fee paths, so only single-money-token "#"
# lines are captured here (avoids mistaking the balance for the fee).
FEE_HASH_KEYWORDS = (
    "service fee",
    "service fees",
    "monthly account fee",
    "account fee",
    "cash deposit fee",
    "cash handling fee",
    "admin fee",
    "card fee",
    "bank charge",
    "excess item fee",
    "excess item",
    "item fee",
    "unpaid item",
    "excess fee",
    "declined fee",
    "penalty fee",
)


def parse_hash_fee_lines(full_text: str, metadata: dict[str, Any]) -> list[ParsedTransaction]:
    transactions: list[ParsedTransaction] = []
    fallback_date = metadata.get("statement_period_end") or ""
    for raw in full_text.splitlines():
        line = strip_fnb_page_artifacts(raw).strip()
        if "#" not in line:
            continue
        money = list(MONEY_TOKEN.finditer(line))
        if len(money) != 1:
            # Two+ tokens means a running balance is present — handled elsewhere.
            continue
        token = money[0]
        hash_index = line.find("#")
        desc = re.sub(r"\s+", " ", line[hash_index:token.start()]).strip(" #").strip()
        if not any(keyword in desc.lower() for keyword in FEE_HASH_KEYWORDS):
            continue
        amount = parse_money_cell(token.group(0))
        if amount is None or amount == 0:
            continue
        date_match = LOOSE_DATE.match(line)
        raw_date = date_match.group("date") if date_match else fallback_date
        transaction = build_transaction(
            raw_date,
            f"# {desc}",
            decimal_to_float(amount.copy_abs()),
            None,
            None,
            metadata,
            None,
            line,
            98,
        )
        if transaction:
            transaction.bank_charge = True
            transactions.append(transaction)
    return transactions


def service_fee_candidate_lines(full_text: str) -> list[str]:
    lines = [strip_fnb_page_artifacts(line) for line in full_text.splitlines()]
    candidates: list[str] = []
    current = ""

    for line in lines:
        if is_fnb_page_artifact(line):
            if current:
                candidates.append(current.strip())
                current = ""
            continue
        starts_new_fee = bool(LOOSE_DATE.match(line)) and (
            "#service fees" in line.lower() or "#monthly account fee" in line.lower()
        )
        starts_any_transaction = bool(LOOSE_DATE.match(line))

        if starts_new_fee:
            if current:
                candidates.append(current.strip())
            current = line
            continue

        if current and starts_any_transaction:
            candidates.append(current.strip())
            current = ""
            continue

        if current:
            current = f"{current} {line}".strip()

    if current:
        candidates.append(current.strip())

    return candidates


def parse_fnb_service_fee_transactions(full_text: str, metadata: dict[str, Any]) -> list[ParsedTransaction]:
    transactions: list[ParsedTransaction] = []
    for line in service_fee_candidate_lines(full_text):
        transaction = parse_fnb_transaction_line(line, metadata, 98)
        if transaction:
            transactions.append(transaction)
    return transactions


def normalize_cell(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def header_kind(value: str) -> str | None:
    lowered = value.lower()
    if "date" in lowered:
        return "date"
    if any(token in lowered for token in ("description", "details", "transaction", "reference", "narrative")):
        return "description"
    if "amount" in lowered:
        return "amount"
    if "accrued" in lowered and ("charge" in lowered or "bank" in lowered):
        return "accrued_charges"
    if any(token in lowered for token in ("debit", "withdrawal", "payment", "money out")):
        return "debit"
    if any(token in lowered for token in ("credit", "deposit", "receipt", "money in")):
        return "credit"
    if "balance" in lowered:
        return "balance"
    return None


def find_header_index(headers: dict[int, str], *kinds: str) -> int | None:
    for kind in kinds:
        for index, header in headers.items():
            if header == kind:
                return index
    return None


def row_value(cells: list[str], index: int | None) -> str:
    if index is None or index < 0 or index >= len(cells):
        return ""
    return cells[index]


def parse_table_transactions(pages: list[dict[str, Any]], metadata: dict[str, Any]) -> list[ParsedTransaction]:
    transactions: list[ParsedTransaction] = []

    for page in pages:
        page_number = page.get("page")
        for table in page.get("tables", []) or []:
            active_headers: dict[int, str] = {}

            for row in table or []:
                cells = [normalize_cell(cell) for cell in row or []]
                if not any(cells):
                    continue

                inferred = {index: header_kind(cell) for index, cell in enumerate(cells)}
                header_hits = [kind for kind in inferred.values() if kind]
                if len(header_hits) >= 2 and "date" in header_hits:
                    active_headers = {index: kind for index, kind in inferred.items() if kind}
                    continue

                date_index = find_header_index(active_headers, "date")
                if date_index is None:
                    date_index = next((index for index, cell in enumerate(cells) if LOOSE_DATE.search(cell)), None)
                if date_index is None:
                    continue

                raw_date_match = LOOSE_DATE.search(cells[date_index])
                if not raw_date_match:
                    continue
                raw_date = raw_date_match.group("date")

                description_index = find_header_index(active_headers, "description")
                amount_index = find_header_index(active_headers, "amount", "debit", "credit")
                balance_index = find_header_index(active_headers, "balance")
                charges_index = find_header_index(active_headers, "accrued_charges")

                if not active_headers and len(cells) >= 4:
                    description_index = 1 if len(cells) > 1 else None
                    money_cell_indexes = [index for index, cell in enumerate(cells) if index != date_index and looks_like_money(cell)]
                    if len(money_cell_indexes) >= 2:
                        amount_index = money_cell_indexes[0]
                        balance_index = money_cell_indexes[1]
                        charges_index = money_cell_indexes[2] if len(money_cell_indexes) >= 3 else None
                    elif len(cells) >= 5:
                        amount_index = 2
                        balance_index = 3
                        charges_index = 4
                    else:
                        amount_index = 2
                        balance_index = 3

                debit: float | None = None
                credit: float | None = None
                balance = decimal_to_float(parse_money_cell(row_value(cells, balance_index)))

                if amount_index is not None:
                    parsed_amount = parse_transaction_amount_cell(row_value(cells, amount_index))
                    if parsed_amount:
                        debit, credit = parsed_amount
                elif find_header_index(active_headers, "debit") is not None or find_header_index(active_headers, "credit") is not None:
                    debit_amount = parse_money_cell(row_value(cells, find_header_index(active_headers, "debit")))
                    credit_amount = parse_money_cell(row_value(cells, find_header_index(active_headers, "credit")))
                    debit = decimal_to_float(debit_amount.copy_abs()) if debit_amount is not None else None
                    credit = decimal_to_float(credit_amount.copy_abs()) if credit_amount is not None else None

                if debit is None and credit is None:
                    continue

                if description_index is not None:
                    description = row_value(cells, description_index)
                else:
                    description_cells = []
                    for index, cell in enumerate(cells):
                        if index in {date_index, amount_index, balance_index, charges_index}:
                            continue
                        cleaned = LOOSE_DATE.sub("", cell).strip()
                        if cleaned and not looks_like_money(cleaned):
                            description_cells.append(cleaned)
                    description = " ".join(description_cells)

                raw_text = " | ".join(cells)
                charge_amount = parse_money_cell(row_value(cells, charges_index))
                transaction = build_transaction(raw_date, description, debit, credit, balance, metadata, page_number, raw_text, 90)
                if transaction:
                    if charge_amount is not None and charge_amount != 0:
                        transaction.bank_charge = True
                        transaction.account_category = "Bank Charges"
                        transaction.vat_treatment = "out_of_scope"
                    transactions.append(transaction)

    return transactions


def parse_text_transactions(pages: list[dict[str, Any]], metadata: dict[str, Any]) -> list[ParsedTransaction]:
    transactions: list[ParsedTransaction] = []
    for page in pages:
        for raw_line in page["text"].splitlines():
            line = re.sub(r"\s+", " ", raw_line).strip()
            match = TRANSACTION_LINE.match(line)
            if match:
                amount1 = parse_money(match.group("amount1"))
                amount2 = parse_money(match.group("amount2"))
                balance = parse_money(match.group("balance"))
                debit = None
                credit = None

                if amount2 is not None:
                    debit = amount1 if amount1 and amount1 > 0 else None
                    credit = amount2 if amount2 and amount2 > 0 else None
                elif amount1 is not None:
                    if amount1 < 0:
                        debit = abs(amount1)
                    else:
                        debit = amount1

                transaction = build_transaction(match.group("date"), match.group("description"), debit, credit, balance, metadata, page["page"], line, 74)
                if transaction:
                    transactions.append(transaction)
                    continue

            date_match = LOOSE_DATE.search(line)
            money_matches = list(LOOSE_MONEY.finditer(line))
            if not date_match or not money_matches:
                continue

            amounts = [(match.group(0), parse_money(match.group(0))) for match in money_matches]
            parsed_amounts = [(raw, amount) for raw, amount in amounts if amount is not None]
            if not parsed_amounts:
                continue

            balance = parsed_amounts[-1][1] if len(parsed_amounts) >= 2 else None
            transaction_amount_raw, transaction_amount = parsed_amounts[-2] if len(parsed_amounts) >= 2 else parsed_amounts[-1]
            debit = None
            credit = None
            hint = money_sign_hint(transaction_amount_raw)
            if hint == "credit" or (transaction_amount is not None and transaction_amount < 0):
                credit = abs(transaction_amount or 0)
            else:
                debit = abs(transaction_amount or 0) if transaction_amount is not None else None

            description_start = date_match.end()
            description_end = money_matches[0].start()
            description = line[description_start:description_end]
            transaction = build_transaction(date_match.group("date"), description, debit, credit, balance, metadata, page["page"], line, 64)
            if transaction:
                transactions.append(transaction)

    return transactions


def dedupe_transactions(transactions: list[ParsedTransaction]) -> list[ParsedTransaction]:
    seen: set[tuple[str | None, str, float | None, float | None, float | None]] = set()
    deduped: list[ParsedTransaction] = []
    for transaction in transactions:
        key = (
            transaction.transaction_date,
            transaction.description.lower(),
            transaction.debit_amount,
            transaction.credit_amount,
            transaction.running_balance,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(transaction)
    return deduped


def shift_iso_date(value: str | None, days: int) -> str | None:
    if not value:
        return None
    try:
        from datetime import timedelta

        return (date.fromisoformat(value) + timedelta(days=days)).isoformat()
    except Exception:
        return value


def is_month_end_fee_gap(transaction_date: str | None, missing_debit: Decimal) -> bool:
    if missing_debit < Decimal("500.00") or missing_debit > Decimal("800.00"):
        return False
    if not transaction_date:
        return False
    try:
        return date.fromisoformat(transaction_date).day >= 24
    except Exception:
        return False


def is_inferable_fnb_bank_charge_gap(transaction: ParsedTransaction, missing_debit: Decimal) -> bool:
    if missing_debit <= 0 or missing_debit > Decimal("2000.00"):
        return False
    if missing_debit <= Decimal("20.00"):
        return True
    text = f"{transaction.description} {transaction.raw_text or ''}".lower()
    if any(token in text for token in ("byc debit", "#service fee", "#monthly account fee", "bank charges", "service fees")):
        return True
    return is_month_end_fee_gap(transaction.transaction_date, missing_debit)


def insert_inferred_fnb_service_fees(
    transactions: list[ParsedTransaction],
    metadata: dict[str, Any],
) -> list[ParsedTransaction]:
    if not transactions or metadata.get("opening_balance") is None:
        return transactions

    previous_balance = decimal_amount(metadata.get("opening_balance"))
    enhanced: list[ParsedTransaction] = []
    inferred_count = 0
    missing_gaps: list[dict[str, Any]] = []

    for transaction in transactions:
        if transaction.running_balance is None:
            enhanced.append(transaction)
            continue

        debit = decimal_amount(transaction.debit_amount)
        credit = decimal_amount(transaction.credit_amount)
        current_balance = decimal_amount(transaction.running_balance)
        expected_balance = (previous_balance + credit - debit).quantize(CENT)
        missing_debit = (expected_balance - current_balance).quantize(CENT)

        if is_inferable_fnb_bank_charge_gap(transaction, missing_debit):
            fee_balance = previous_balance
            fee_balance = (fee_balance - missing_debit).quantize(CENT)
            inferred = build_transaction(
                transaction.transaction_date or "",
                "#Monthly Account Fee / Service Fees - inferred from balance movement",
                decimal_to_float(missing_debit),
                None,
                decimal_to_float(fee_balance),
                metadata,
                transaction.source_page,
                (
                    "Inferred FNB service fee from running-balance gap. "
                    f"inferred_service_fee=true reason=running balance gap gap_amount={missing_debit} before: {transaction.raw_text}"
                ),
                91,
            )
            if inferred:
                inferred.bank_charge = True
                inferred.account_category = "Bank Charges"
                inferred.vat_treatment = "out_of_scope"
                inferred.review_status = "ready"
                inferred.notes = f"inferred_service_fee: true; reason: running balance gap; gap_amount: {missing_debit}"
                enhanced.append(inferred)
                inferred_count += 1
        elif missing_debit != 0:
            missing_gaps.append(
                {
                    "current_transaction": transaction.raw_text,
                    "current_description": transaction.description,
                    "current_date": transaction.transaction_date,
                    "previous_balance": previous_balance,
                    "expected_balance": expected_balance,
                    "actual_balance": current_balance,
                    "gap_amount": missing_debit,
                }
            )

        enhanced.append(transaction)
        previous_balance = current_balance

    if inferred_count:
        log_event(
            "worker.inferred_fnb_service_fees",
            worker=worker_version(),
            inferred_count=inferred_count,
            parser_version=WORKER_PARSER_VERSION,
        )

    if missing_gaps:
        log_warning(
            "worker.fnb_balance_gaps",
            worker=worker_version(),
            gap_count=len(missing_gaps),
            gaps=missing_gaps[:10],
            parser_version=WORKER_PARSER_VERSION,
        )

    return dedupe_transactions(enhanced)


def normalize_transactions_from_balances(
    transactions: list[ParsedTransaction],
    opening_balance: float | int | str | None,
) -> list[ParsedTransaction]:
    if opening_balance is None:
        return transactions

    previous_balance = decimal_amount(opening_balance)
    normalized: list[ParsedTransaction] = []

    for transaction in transactions:
        if transaction.running_balance is None:
            normalized.append(transaction)
            continue

        current_balance = decimal_amount(transaction.running_balance)
        delta = (current_balance - previous_balance).quantize(CENT)
        previous_balance = current_balance

        if delta == 0:
            normalized.append(transaction)
            continue

        if delta > 0:
            transaction.credit_amount = decimal_to_float(delta)
            transaction.debit_amount = None
        else:
            transaction.debit_amount = decimal_to_float(delta.copy_abs())
            transaction.credit_amount = None

        category, vat, bank_charge, rule_confidence = classify_transaction(
            transaction.description,
            transaction.debit_amount,
            transaction.credit_amount,
        )
        transaction.account_category = category
        transaction.vat_treatment = vat
        transaction.bank_charge = transaction.bank_charge or bank_charge
        transaction.confidence = min(99, max(transaction.confidence, rule_confidence, 92))
        transaction.review_status = "ready" if transaction.confidence >= 85 else "needs_review"
        normalized.append(transaction)

    return normalized


def parse_transactions(pages: list[dict[str, Any]], metadata: dict[str, Any], full_text: str = "") -> list[ParsedTransaction]:
    section_transactions = parse_fnb_section_transactions(full_text, metadata) if full_text else []
    if section_transactions:
        service_fee_transactions = parse_fnb_service_fee_transactions(full_text, metadata) if full_text else []
        hash_fee_transactions = parse_hash_fee_lines(full_text, metadata) if full_text else []
        parsed = dedupe_transactions([*section_transactions, *service_fee_transactions, *hash_fee_transactions])
        return insert_inferred_fnb_service_fees(parsed, metadata)
    table_transactions = parse_table_transactions(pages, metadata)
    if table_transactions:
        hash_fee_transactions = parse_hash_fee_lines(full_text, metadata) if full_text else []
        merged = dedupe_transactions([*table_transactions, *hash_fee_transactions])
        return normalize_transactions_from_balances(merged, metadata.get("opening_balance"))
    return dedupe_transactions(parse_text_transactions(pages, metadata))


def decimal_amount(value: float | int | str | None) -> Decimal:
    if value is None:
        return Decimal("0.00")
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def validation_summary(transactions: list[ParsedTransaction]) -> dict[str, Any]:
    total_debits = sum((decimal_amount(transaction.debit_amount) for transaction in transactions), Decimal("0.00"))
    total_credits = sum((decimal_amount(transaction.credit_amount) for transaction in transactions), Decimal("0.00"))
    debit_count = sum(1 for transaction in transactions if decimal_amount(transaction.debit_amount) > 0)
    credit_count = sum(1 for transaction in transactions if decimal_amount(transaction.credit_amount) > 0)
    return {
        "total_debits": total_debits.quantize(CENT),
        "total_credits": total_credits.quantize(CENT),
        "debit_count": debit_count,
        "credit_count": credit_count,
    }


def bank_charges_from_statement(metadata: dict[str, Any], transactions: list[ParsedTransaction]) -> Decimal:
    """Bank charges come from the statement's declared fee summary first (Service
    Fees + Cash Deposit Fees), falling back to the sum of extracted fee rows.
    Never from cash-deposit transaction amounts."""
    declared = Decimal("0.00")
    for key in ("declared_service_fees", "declared_cash_deposit_fees"):
        value = metadata.get(key)
        if value is not None:
            declared += decimal_amount(value)
    if declared > 0:
        return declared.quantize(CENT)
    return sum(
        (decimal_amount(t.debit_amount) for t in transactions if t.bank_charge),
        Decimal("0.00"),
    ).quantize(CENT)


def validate_extraction(metadata: dict[str, Any], transactions: list[ParsedTransaction]) -> dict[str, Any]:
    """General, bank-agnostic extraction validation. Compares what we extracted
    against the statement's own declared totals and the opening/closing balance.
    Returns a structured report; status is 'ok' only when everything ties out."""
    summary = validation_summary(transactions)
    checks: list[dict[str, Any]] = []
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str, extracted: Any = None, expected: Any = None) -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail, "extracted": extracted, "expected": expected})
        if not ok:
            failures.append(name)

    tolerance = Decimal("0.05")

    opening = metadata.get("opening_balance")
    closing = metadata.get("closing_balance")
    recon_diff = None
    if opening is not None and closing is not None:
        expected_close = (decimal_amount(opening) + summary["total_credits"] - summary["total_debits"]).quantize(CENT)
        recon_diff = (expected_close - decimal_amount(closing)).quantize(CENT)
        check("reconciliation", abs(recon_diff) <= tolerance, f"difference {recon_diff}", str(expected_close), str(decimal_amount(closing)))

    expected_count = metadata.get("expected_transaction_count")
    if expected_count is not None:
        actual = len(transactions)
        check("transaction_count", actual == expected_count, f"extracted {actual} of {expected_count}", actual, expected_count)

    if metadata.get("expected_credit_count") is not None:
        check("credit_count", summary["credit_count"] == metadata["expected_credit_count"],
              f"extracted {summary['credit_count']} of {metadata['expected_credit_count']}", summary["credit_count"], metadata["expected_credit_count"])
    if metadata.get("expected_debit_count") is not None:
        check("debit_count", summary["debit_count"] == metadata["expected_debit_count"],
              f"extracted {summary['debit_count']} of {metadata['expected_debit_count']}", summary["debit_count"], metadata["expected_debit_count"])

    if metadata.get("declared_credit_total") is not None:
        declared = decimal_amount(metadata["declared_credit_total"])
        diff = (summary["total_credits"] - declared).quantize(CENT)
        check("credit_total", abs(diff) <= tolerance, f"variance {diff}", str(summary["total_credits"]), str(declared))
    if metadata.get("declared_debit_total") is not None:
        declared = decimal_amount(metadata["declared_debit_total"])
        diff = (summary["total_debits"] - declared).quantize(CENT)
        check("debit_total", abs(diff) <= tolerance, f"variance {diff}", str(summary["total_debits"]), str(declared))

    bank_charges = bank_charges_from_statement(metadata, transactions)
    return {
        "status": "ok" if not failures else "review_required",
        "failures": failures,
        "checks": checks,
        "reconciliation_difference": str(recon_diff) if recon_diff is not None else None,
        "extracted_transaction_count": len(transactions),
        "expected_transaction_count": expected_count,
        "extracted_credits": str(summary["total_credits"]),
        "extracted_debits": str(summary["total_debits"]),
        "bank_charges": str(bank_charges),
    }


def extraction_money_checks_passed(extraction_check: dict[str, Any]) -> bool:
    money_rules = {"reconciliation", "credit_total", "debit_total"}
    checks = extraction_check.get("checks") or []
    found = {check.get("name"): bool(check.get("ok")) for check in checks if check.get("name") in money_rules}
    return all(found.get(rule, False) for rule in money_rules)


def missing_transaction_count_for_storage(extraction_check: dict[str, Any], transaction_count: int) -> int | None:
    expected_count = extraction_check.get("expected_transaction_count")
    if expected_count is None:
        return None
    # FNB's printed transaction-count control can be out by one when hidden
    # service-fee/bank-charge rows are represented differently from visible
    # transaction rows. If the money controls reconcile exactly, do not tell the
    # user a transaction is missing; keep the run in review, but with no
    # suspected missing-money count.
    if extraction_money_checks_passed(extraction_check):
        return 0
    return max(0, int(expected_count) - transaction_count)


def balance_gap_diagnostics(metadata: dict[str, Any], transactions: list[ParsedTransaction]) -> list[dict[str, Any]]:
    if metadata.get("opening_balance") is None:
        return []
    previous_balance = decimal_amount(metadata.get("opening_balance"))
    previous_transaction: ParsedTransaction | None = None
    gaps: list[dict[str, Any]] = []
    for transaction in transactions:
        if transaction.running_balance is None:
            continue
        debit = decimal_amount(transaction.debit_amount)
        credit = decimal_amount(transaction.credit_amount)
        actual_balance = decimal_amount(transaction.running_balance)
        expected_balance = (previous_balance + credit - debit).quantize(CENT)
        gap_amount = (expected_balance - actual_balance).quantize(CENT)
        if gap_amount != 0:
            gaps.append(
                {
                    "previous_row": previous_transaction.raw_text if previous_transaction else "Opening balance",
                    "current_row": transaction.raw_text,
                    "current_date": transaction.transaction_date,
                    "current_description": transaction.description,
                    "previous_balance": str(previous_balance),
                    "expected_balance": str(expected_balance),
                    "actual_balance": str(actual_balance),
                    "gap_amount": str(gap_amount),
                    "nearby_raw_lines": [
                        item
                        for item in [
                            previous_transaction.raw_text if previous_transaction else None,
                            transaction.raw_text,
                        ]
                        if item
                    ],
                }
            )
        previous_balance = actual_balance
        previous_transaction = transaction
    return gaps


# Human-readable names for each validation rule, surfaced in the UI and logs.
FRIENDLY_RULE = {
    "reconciliation": "Reconciliation",
    "transaction_count": "Transaction count",
    "credit_count": "Credit count",
    "debit_count": "Debit count",
    "credit_total": "Credit total",
    "debit_total": "Debit total",
}


def format_check_error(check: dict[str, Any]) -> str:
    label = FRIENDLY_RULE.get(check["name"], check["name"])
    extracted = check.get("extracted")
    expected = check.get("expected")
    if check["name"] == "reconciliation":
        return f"Reconciliation: expected closing {expected}, calculated {extracted} (difference {check['detail'].replace('difference ', '')})"
    if extracted is not None and expected is not None:
        return f"{label}: extracted {extracted} vs declared {expected}"
    return f"{label}: {check['detail']}"


def validate_statement(metadata: dict[str, Any], transactions: list[ParsedTransaction]) -> dict[str, Any]:
    # General, bank-agnostic validation against the statement's OWN declared
    # figures (no hardcoded per-statement expectations). Every failed rule is
    # surfaced with its extracted vs declared values.
    extraction = validate_extraction(metadata, transactions)
    summary = validation_summary(transactions)
    opening = decimal_amount(metadata.get("opening_balance"))
    closing = decimal_amount(metadata.get("closing_balance"))
    calculated_closing = (opening + summary["total_credits"] - summary["total_debits"]).quantize(CENT)

    failed_checks = [check for check in extraction["checks"] if not check["ok"]]
    errors = [format_check_error(check) for check in failed_checks]

    result = {
        "opening_balance": opening,
        "closing_balance": closing,
        "calculated_closing": calculated_closing,
        **summary,
        "transaction_count": len(transactions),
    }
    if errors:
        expected_count = metadata.get("expected_transaction_count")
        suspected_missing = max(0, int(expected_count) - len(transactions)) if expected_count is not None else None
        balance_gaps = balance_gap_diagnostics(metadata, transactions)
        sample_transactions = [
            {
                "date": transaction.transaction_date,
                "description": transaction.description,
                "debit": transaction.debit_amount,
                "credit": transaction.credit_amount,
                "balance": transaction.running_balance,
                "raw": transaction.raw_text,
            }
            for transaction in transactions[:80]
        ]
        raise HTTPException(
            status_code=422,
            detail=with_worker_version({
                "message": "FNB parser validation failed.",
                "errors": errors,
                "failed_rules": [check["name"] for check in failed_checks],
                "checks": extraction["checks"],
                "reconciliation_difference": extraction.get("reconciliation_difference"),
                "extracted_transaction_count": len(transactions),
                "expected_transaction_count": expected_count,
                "suspected_missing_rows": suspected_missing,
                "summary": {key: str(value) for key, value in result.items()},
                "balance_gaps": balance_gaps[:20],
                "sample_transactions": sample_transactions,
            }),
        )
    return result


def review_validation_issue(exc: HTTPException) -> dict[str, Any] | None:
    detail = exc.detail
    if not isinstance(detail, dict) or detail.get("message") != "FNB parser validation failed.":
        return None
    errors = detail.get("errors") if isinstance(detail.get("errors"), list) else []
    summary = detail.get("summary") if isinstance(detail.get("summary"), dict) else {}
    balance_gaps = detail.get("balance_gaps") if isinstance(detail.get("balance_gaps"), list) else []
    checks = detail.get("checks") if isinstance(detail.get("checks"), list) else []
    return {
        "message": "Review required — extraction does not reconcile with the declared statement figures.",
        "errors": [str(error) for error in errors],
        "failed_rules": detail.get("failed_rules") if isinstance(detail.get("failed_rules"), list) else [],
        "checks": checks,
        "summary": summary,
        "reconciliation_difference": detail.get("reconciliation_difference"),
        "extracted_transaction_count": detail.get("extracted_transaction_count"),
        "expected_transaction_count": detail.get("expected_transaction_count"),
        "suspected_missing_rows": detail.get("suspected_missing_rows"),
        "balance_gaps": balance_gaps,
    }


def review_error_message(issue: dict[str, Any] | None) -> str | None:
    if not issue:
        return None
    errors = issue.get("errors") if isinstance(issue.get("errors"), list) else []
    if errors:
        # Detailed, specific reason (which rules failed + extracted vs declared).
        return "Review required — " + "; ".join(str(error) for error in errors[:6]) + "."
    return str(issue["message"])


def explain_line_rejection(line: str, metadata: dict[str, Any]) -> str:
    """Why did this candidate transaction line not produce a transaction?"""
    stripped = strip_fnb_page_artifacts(line)
    if not LOOSE_DATE.match(stripped):
        return "no leading date"
    money = list(MONEY_TOKEN.finditer(stripped))
    if not money:
        return "no money amount"
    if parse_fnb_transaction_line(stripped, metadata) is not None:
        return "parsed (unexpected)"
    if parse_single_amount_line(stripped, metadata) is not None:
        return "parsed (unexpected)"
    if parse_amount_balance_line(stripped, metadata) is not None:
        return "parsed (unexpected)"
    if len(money) >= 3:
        return "3+ money tokens without a Cr/Dr balance suffix"
    if len(money) == 2:
        return "amount + balance without a Cr/Dr suffix (unhandled)"
    return "unrecognised line shape"


def extraction_diagnostics(pages: list[dict[str, Any]], full_text: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    metadata = metadata or {}
    section = transaction_section_lines(full_text) if full_text else []
    candidates = transaction_candidate_lines(full_text) if full_text else []

    def candidate_parsed(candidate: str) -> bool:
        return bool(
            parse_fnb_transaction_line(candidate, metadata)
            or parse_single_amount_line(candidate, metadata)
            or parse_amount_balance_line(candidate, metadata)
        )

    parsed = 0
    rejected: list[dict[str, str]] = []
    for candidate in candidates:
        if candidate_parsed(candidate):
            parsed += 1
        else:
            if len(rejected) < 20:
                rejected.append({"line": candidate[:160], "reason": explain_line_rejection(candidate, metadata)})

    page_texts = [str(page.get("text") or "") for page in pages if str(page.get("text") or "").strip()]
    if not page_texts and full_text:
        page_texts = [chunk for chunk in re.split(r"\f+", full_text) if chunk.strip()] or [full_text]
    page_diagnostics: list[dict[str, Any]] = []
    for idx, page_text in enumerate(page_texts, start=1):
        page_candidates = transaction_candidate_lines(page_text)
        page_parsed = sum(1 for candidate in page_candidates if candidate_parsed(candidate))
        page_diagnostics.append(
            {
                "page": idx,
                "candidate_line_count": len(page_candidates),
                "parsed_candidate_count": page_parsed,
                "rejected_candidate_count": max(len(page_candidates) - page_parsed, 0),
                "candidate_lines_sample": [candidate[:120] for candidate in page_candidates[:6]],
            }
        )

    sample_lines = []
    for line in full_text.splitlines():
        cleaned = re.sub(r"\s+", " ", line).strip()
        if cleaned and len(cleaned) > 3:
            sample_lines.append(cleaned)
        if len(sample_lines) >= 30:
            break

    return {
        "pages_scanned": len(pages),
        "characters": len(full_text),
        "transaction_section_found": bool(section),
        "section_line_count": len(section),
        "candidate_line_count": len(candidates),
        "candidate_lines_sample": [c[:160] for c in candidates[:20]],
        "parsed_candidate_count": parsed,
        "rejected_candidate_count": len(candidates) - parsed,
        "rejected_samples": rejected,
        "table_count": sum(len(page.get("tables", []) or []) for page in pages),
        "page_diagnostics": page_diagnostics,
        "sample_lines": sample_lines,
        "extracted_metadata": {key: str(value) for key, value in metadata.items() if value is not None},
    }


HEADER_FILL = PatternFill("solid", fgColor="0F2A5F")
SUBTLE_FILL = PatternFill("solid", fgColor="EAF3FF")
PASS_FILL = PatternFill("solid", fgColor="DCFCE7")
FAIL_FILL = PatternFill("solid", fgColor="FEE2E2")
THIN_BORDER = Border(bottom=Side(style="thin", color="D8E1F0"))
CURRENCY_FORMAT = '"R"#,##0.00;[Red]-"R"#,##0.00'


def write_row(sheet, values: list[Any], row_index: int, header: bool = False) -> None:
    for column_index, value in enumerate(values, start=1):
        cell = sheet.cell(row=row_index, column=column_index, value=value)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        cell.border = THIN_BORDER
        if header:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = HEADER_FILL


def write_row_at(sheet, values: list[Any], row_index: int, start_column: int, header: bool = False) -> None:
    for offset, value in enumerate(values):
        cell = sheet.cell(row=row_index, column=start_column + offset, value=value)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        cell.border = THIN_BORDER
        if header:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = HEADER_FILL


def money_total(values: list[float | None]) -> Decimal:
    return sum((decimal_amount(value) for value in values), Decimal("0.00")).quantize(CENT)


def mask_account(value: str | None) -> str:
    if not value:
        return "-"
    cleaned = re.sub(r"\D", "", value)
    if len(cleaned) <= 4:
        return value
    return f"{'*' * max(len(cleaned) - 4, 0)}{cleaned[-4:]}"


def validation_status(metadata: dict[str, Any], transactions: list[ParsedTransaction]) -> tuple[str, Decimal]:
    summary = validation_summary(transactions)
    opening = decimal_amount(metadata.get("opening_balance"))
    closing = decimal_amount(metadata.get("closing_balance"))
    calculated = (opening + summary["total_credits"] - summary["total_debits"]).quantize(CENT)
    return ("PASSED" if calculated == closing else "FAILED", calculated)


def refresh_statement_analytics(supabase: Client, workspace_id: str, bank: str, parser_profile: str, parser_version: str) -> None:
    try:
        runs_response = (
            supabase.table("accounting_statement_runs")
            .select("status,confidence,processing_duration_ms,review_required")
            .eq("workspace_id", workspace_id)
            .eq("bank", bank)
            .execute()
        )
        rows = runs_response.data if isinstance(runs_response.data, list) else []
        if not rows:
            return

        processed = len(rows)
        success = sum(1 for row in rows if str(row.get("status") or "") == "completed")
        confidence = sum(float(row.get("confidence") or 0) for row in rows) / processed
        processing_values = [float(row.get("processing_duration_ms") or 0) for row in rows if row.get("processing_duration_ms") is not None]
        avg_processing = (sum(processing_values) / len(processing_values)) if processing_values else 0
        review_rate = (sum(1 for row in rows if bool(row.get("review_required"))) / processed) * 100
        success_rate = (success / processed) * 100

        supabase.table("accounting_statement_analytics").upsert(
            {
                "workspace_id": workspace_id,
                "bank": bank,
                "statements_processed": processed,
                "success_rate": round(success_rate, 2),
                "average_confidence": round(confidence, 2),
                "average_processing_ms": round(avg_processing, 2),
                "average_review_rate": round(review_rate, 2),
                "updated_at": datetime.utcnow().isoformat(),
            },
            on_conflict="workspace_id,bank",
        ).execute()

        supabase.table("accounting_parser_health").upsert(
            {
                "workspace_id": workspace_id,
                "parser_name": parser_profile,
                "version": parser_version,
                "last_updated": datetime.utcnow().isoformat(),
                "regression_pass_rate": 100 if parser_profile == "fnb_business_v1" else 0,
                "supported_layouts": ["Business Statement"],
                "known_issues": [] if parser_profile == "fnb_business_v1" else ["Profile scaffolding only"],
                "confidence": round(confidence, 2),
                "average_extraction_accuracy": round(confidence, 2),
            },
            on_conflict="workspace_id,parser_name",
        ).execute()
    except Exception as exc:
        log_warning("worker.analytics_refresh_failed", workspace_id=workspace_id, bank=bank, error=str(exc))


def record_parser_failure(supabase: Client, workspace_id: str, bank: str, reason: str) -> None:
    normalized = reason.strip()[:220] if reason else "Unknown failure"
    try:
        current_response = (
            supabase.table("accounting_parser_failures")
            .select("id,failure_count")
            .eq("workspace_id", workspace_id)
            .eq("bank", bank)
            .eq("failure_reason", normalized)
            .maybe_single()
            .execute()
        )
        current = current_response.data if isinstance(current_response.data, dict) else None
        if current and current.get("id"):
            supabase.table("accounting_parser_failures").update(
                {
                    "failure_count": int(current.get("failure_count") or 0) + 1,
                    "updated_at": datetime.utcnow().isoformat(),
                }
            ).eq("id", current["id"]).execute()
            return

        supabase.table("accounting_parser_failures").insert(
            {
                "workspace_id": workspace_id,
                "bank": bank,
                "failure_reason": normalized,
                "failure_count": 1,
                "updated_at": datetime.utcnow().isoformat(),
            }
        ).execute()
    except Exception as exc:
        log_warning("worker.parser_failure_record_failed", workspace_id=workspace_id, bank=bank, reason=normalized, error=str(exc))


def statement_run_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "company_name",
        "account_number",
        "statement_period_start",
        "statement_period_end",
        "statement_date",
        "opening_balance",
        "closing_balance",
        "parser_profile",
        "parser_version",
    }
    return {key: metadata.get(key) for key in allowed if key in metadata}


# Columns that may not exist yet if their migration has not been applied to the
# live database. They are dropped (with a warning) rather than failing the job.
OPTIONAL_RUN_COLUMNS = ("statement_date", "processing_step")


def is_missing_column_error(message: str) -> bool:
    lowered = message.lower()
    return (
        "schema cache" in lowered
        or "could not find" in lowered
        or ("column" in lowered and ("does not exist" in lowered or "not found" in lowered))
    )


def update_statement_run(supabase: Client, run_id: str, workspace_id: str, fields: dict[str, Any]) -> None:
    """Update the run record, retrying without OPTIONAL columns when the DB schema
    is missing them (e.g. statement_date before migration 012 is applied), so a
    missing migration never fails the whole processing job with HTTP 422."""
    try:
        supabase.table("accounting_statement_runs").update(fields).eq("id", run_id).eq("workspace_id", workspace_id).execute()
        return
    except Exception as exc:  # noqa: BLE001 — degrade gracefully on schema mismatch only
        droppable = [column for column in OPTIONAL_RUN_COLUMNS if column in fields]
        if not droppable or not is_missing_column_error(str(exc)):
            raise
        safe_fields = {key: value for key, value in fields.items() if key not in OPTIONAL_RUN_COLUMNS}
        log_warning("worker.run_update_dropped_optional_columns", run_id=run_id, dropped=droppable, error=str(exc))
        supabase.table("accounting_statement_runs").update(safe_fields).eq("id", run_id).eq("workspace_id", workspace_id).execute()


def heartbeat_step(
    supabase: Client,
    *,
    run_id: str,
    workspace_id: str,
    processing_job_id: str | None,
    step_label: str,
    progress: int,
) -> None:
    now_iso = datetime.utcnow().isoformat()
    update_statement_run(
        supabase,
        run_id,
        workspace_id,
        {
            "processing_step": step_label,
            "updated_at": now_iso,
        },
    )
    if processing_job_id:
        supabase.table("processing_jobs").update(
            {
                "status": "running",
                "progress": progress,
                "message": step_label,
                "updated_at": now_iso,
            }
        ).eq("id", processing_job_id).execute()


def review_reason(transaction: ParsedTransaction) -> str:
    reasons: list[str] = []
    text = transaction.description.lower()
    if transaction.confidence < 80:
        reasons.append("Low confidence")
    if transaction.account_category in {"Review Required", "Uncategorised", "Uncategorised Expense"}:
        reasons.append("Unknown or ambiguous supplier")
    if transaction.vat_treatment == "review":
        reasons.append("VAT treatment requires review")
    if any(token in text for token in ("uber eats", "meal", "restaurant", "spa", "puppy", "photography")):
        reasons.append("Personal-looking or entertainment expense")
    if transaction.debit_amount and transaction.account_category not in {"Bank Charges", "Salaries & Wages", "Inter-account Transfer"}:
        reasons.append("Invoice support required")
    return "; ".join(dict.fromkeys(reasons)) or transaction.notes or "Review recommended"


def should_review(transaction: ParsedTransaction) -> bool:
    return (
        transaction.review_status == "needs_review"
        or transaction.confidence < 80
        or transaction.vat_treatment == "review"
        or transaction.account_category in {"Review Required", "Uncategorised", "Uncategorised Expense", "Staff Welfare / Meals / Entertainment"}
    )


def apply_number_formats(sheet, currency_columns: list[int], percent_columns: list[int] | None = None) -> None:
    percent_columns = percent_columns or []
    for row in sheet.iter_rows(min_row=2):
        for index in currency_columns:
            if index <= len(row):
                row[index - 1].number_format = CURRENCY_FORMAT
        for index in percent_columns:
            if index <= len(row):
                row[index - 1].number_format = '0"%"'


def finish_sheet(sheet, freeze_pane: str = "A2", filter_ref: str | None = None) -> None:
    sheet.freeze_panes = freeze_pane
    if filter_ref:
        sheet.auto_filter.ref = filter_ref
    for column_index, column_cells in enumerate(sheet.columns, start=1):
        max_length = max(len(str(cell.value or "")) for cell in column_cells)
        sheet.column_dimensions[get_column_letter(column_index)].width = min(max(max_length + 2, 12), 48)


def validate_workbook_for_export(workbook: Workbook) -> None:
    forbidden_errors = {"#NAME?", "#VALUE!", "#REF!", "#DIV/0!", "#N/A"}
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                value = cell.value
                if isinstance(value, str) and value.strip() in forbidden_errors:
                    raise ValueError(f"Workbook export contains {value} in {sheet.title}!{cell.coordinate}")


def workbook_date(value: str | None) -> date | str | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except Exception:
        return value


def transaction_month(transaction: ParsedTransaction) -> str:
    value = transaction.transaction_date or ""
    return value[:7] if len(value) >= 7 else ""


def professional_account(transaction: ParsedTransaction) -> tuple[str, str, str, str]:
    learned_or_rule_category = (transaction.account_category or "").strip()
    learned_map = {
        "Sales / Revenue": ("Sales / Revenue", "Income", "Standard-rated taxable receipts", "Output"),
        "Income": ("Other Income / Review", "Income", "Output VAT if taxable supply", "Output/Review"),
        "Cash Deposits / Revenue": ("Cash Deposits / Revenue", "Income", "Standard-rated taxable receipts unless proven otherwise", "Output"),
        "Bank Charges": ("Bank Charges", "Bank Charges", "Input VAT if valid bank tax invoice", "Input/Review"),
        "Staff Welfare / Meals / Entertainment": ("Meals / Groceries - Non Deductible Review", "Meals/Groceries", "Restricted/Review", "Review"),
        "Software Subscriptions": ("Software / IT", "Software/IT", "Input VAT if valid invoice", "Input/Review"),
        "Software / IT": ("Software / IT", "Software/IT", "Input VAT if valid invoice", "Input/Review"),
        "Telephone / Internet / Communication": ("Telephone / Internet / Communication", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"),
        "Insurance": ("Insurance", "Insurance", "Exempt/No VAT", "No"),
        "Insurance Expense": ("Insurance", "Insurance", "Exempt/No VAT", "No"),
        "Levies": ("Levies", "Property/Levies", "Review", "Review"),
        "Salaries & Wages": ("Salaries / Drawings / Personal", "Payroll/Personal", "No VAT", "No"),
        "Inter-account Transfer": ("Inter-account Transfer", "Transfers", "No VAT", "No"),
        "Related Party / Drawings": ("Director Loan / Drawings", "Transfers", "No VAT", "No"),
        "Loan / Liability": ("Loan / Liability", "Loans", "No VAT", "No"),
        "SARS / Tax Suspense": ("SARS / Tax Suspense", "Taxes", "No VAT", "No"),
        "Courier / Delivery": ("Courier / Freight", "Freight", "Input VAT if valid invoice", "Input/Review"),
        "Motor Vehicle Expenses": ("Motor Vehicle Expenses", "Motor Vehicle", "Input VAT if valid invoice", "Input/Review"),
        "Road Tolls": ("Road Tolls", "Motor Vehicle", "Input VAT if valid invoice", "Input/Review"),
        "Operating Expenses": ("Operating Expenses", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"),
        "Supplier Payments": ("Supplier Payments", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"),
        "Accounting / Professional Fees": ("Accounting / Professional Fees", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"),
        "Medical Expenses": ("Medical Expenses", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"),
        "Utilities": ("Utilities", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"),
        "VAT Control": ("VAT Control", "VAT", "VAT control", "No"),
        "Finance Costs": ("Finance Costs", "Finance Costs", "Exempt/No VAT", "No"),
        "Rent": ("Rent", "Premises", "Input VAT if valid invoice", "Input/Review"),
    }
    if learned_or_rule_category in learned_map and learned_or_rule_category != "Review Required":
        return learned_map[learned_or_rule_category]

    text = transaction.description.lower()
    if transaction.bank_charge or "service fee" in text or "monthly account fee" in text or "byc debit" in text:
        return "Bank Charges", "Bank Charges", "Input VAT if valid bank tax invoice", "Input/Review"
    if any(token in text for token in ("magtape credit 047-gp hea", "gp hea-", "gauteng health", "department of health", "dept of health", "health department")):
        return "Sales / Revenue", "Income", "Standard-rated taxable receipts", "Output"
    if any(token in text for token in ("rmsp trading", "stalitrex", "nms enterprises", "nms enterprises 5290b")):
        return "Supplier Payments", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"
    if looks_like_business_supplier_payment(text):
        return "Supplier Payments", "Operating Expenses", "Input VAT if valid invoice", "Input/Review"
    if "uber eats" in text:
        return "Meals / Groceries - Non Deductible Review", "Meals/Groceries", "Restricted/Review", "Review"
    if "dhl" in text:
        return "Courier / Freight", "Freight", "Input VAT if valid invoice", "Input/Review"
    if any(token in text for token in ("discovery account", "discovery insure", "insurance premium")):
        return "Insurance", "Insurance", "Exempt/No VAT", "No"
    if "transfer to savings" in text:
        return "Inter-account Transfer Out / Loan", "Transfers", "No VAT", "No"
    if "transfer from credit" in text:
        return "Inter-account Transfer In", "Transfers", "No VAT", "No"
    if any(token in text for token in ("salary", "nanny", "care giver", "senses spa", "sloppy kisses", "puppy classes", "alicia", "tanita", "sunfield", "bianca", "nilam", "tammy", "debbie")):
        return "Salaries / Drawings / Personal", "Payroll/Personal", "No VAT", "No"
    if any(token in text for token in ("google chatgpt", "google xiaomi", "xiaomi", "chatgpt")):
        return "Software / IT", "Software/IT", "Input VAT if valid invoice", "Input/Review"
    if transaction.credit_amount:
        return "Other Income / Review", "Income", "Output VAT if taxable supply", "Output/Review"
    return "Unclassified Expense", "Review", "Review", "Review"


def professional_transaction_row(transaction: ParsedTransaction, source_file: str) -> dict[str, Any]:
    money_in = decimal_amount(transaction.credit_amount)
    money_out = decimal_amount(transaction.debit_amount)
    amount = money_in if money_in > 0 else money_out
    account, group, vat_treatment, vat_claim_status = professional_account(transaction)
    reason, explanation = classification_reason(account, transaction.description, transaction.confidence)
    output_vat = (money_in * Decimal("15") / Decimal("115")).quantize(CENT) if vat_claim_status.startswith("Output") else Decimal("0.00")
    input_vat = (money_out * Decimal("15") / Decimal("115")).quantize(CENT) if vat_claim_status.startswith("Input") else Decimal("0.00")
    row = {
        "date": workbook_date(transaction.transaction_date),
        "month": transaction_month(transaction),
        "description": transaction.description,
        "money_in": money_in,
        "money_out": money_out,
        "amount": amount,
        "type": "Receipt" if money_in > 0 else "Payment",
        "balance": decimal_amount(transaction.running_balance),
        "bank_charge": money_out if transaction.bank_charge else Decimal("0.00"),
        "account": account,
        "group": group,
        "vat_treatment": vat_treatment,
        "vat_claim_status": vat_claim_status,
        "potential_output_vat": output_vat,
        "potential_input_vat": input_vat,
        "source_file": source_file,
        "rule_confidence": transaction.confidence,
        "classification_reason": reason,
        "classification_explanation": explanation,
        "ai_used": False,
        "review_required": False,
        "review_reason": "",
        "invoice_required": bool(
            money_out > 0
            and vat_claim_status in {"Review", "Input/Review", "Output/Review"}
            and group not in {"Bank Charges", "Transfers", "Payroll/Personal", "Insurance"}
        ),
    }
    row["review_reason"] = professional_review_reason(row) or ""
    row["review_required"] = bool(row["review_reason"])
    return row


def reporting_account(row: dict[str, Any]) -> str:
    if row.get("review_required") or row.get("vat_claim_status") in {"Review", "Output/Review"}:
        return "Review Required Suspense"
    return str(row.get("account") or "Review Required Suspense")


def reporting_vat_status(row: dict[str, Any]) -> str:
    if reporting_account(row) == "Review Required Suspense":
        return "Review"
    return str(row.get("vat_claim_status") or "Review")


def professional_review_reason(row: dict[str, Any]) -> str | None:
    reasons: list[str] = []
    description = str(row["description"]).lower()
    confidence = float(row.get("rule_confidence") or row.get("ai_confidence") or 0)
    if confidence and confidence < 68:
        reasons.append("Low confidence classification")
    if row["account"] in {
        "Unclassified Expense",
        "Other Income / Review",
        "Meals / Groceries - Non Deductible Review",
        "Review Required Suspense",
    }:
        reasons.append("Unknown or unclear supplier")
    if row["vat_claim_status"] in {"Review", "Output/Review"}:
        reasons.append("VAT treatment uncertain")
    if row.get("invoice_required") and row["vat_claim_status"] == "Review":
        reasons.append("Invoice support required")
    if any(token in description for token in ("uber eats", "meal", "restaurant", "spa", "puppy", "photography", "sloppy kisses", "senses spa", "adore")):
        reasons.append("Personal-looking or entertainment expense")
    if "transfer" in description and row["group"] not in {"Transfers"}:
        reasons.append("Unusual transfer classification")
    return "; ".join(dict.fromkeys(reasons)) if reasons else None


def recompute_professional_vat(row: dict[str, Any]) -> None:
    money_in = decimal_amount(row.get("money_in"))
    money_out = decimal_amount(row.get("money_out"))
    claim_status = str(row.get("vat_claim_status") or "")
    row["potential_output_vat"] = (money_in * Decimal("15") / Decimal("115")).quantize(CENT) if claim_status.startswith("Output") else Decimal("0.00")
    row["potential_input_vat"] = (money_out * Decimal("15") / Decimal("115")).quantize(CENT) if claim_status.startswith("Input") else Decimal("0.00")


def accounting_ai_model() -> str:
    return os.getenv("OPENAI_ACCOUNTING_MODEL") or os.getenv("OPENAI_MODEL") or DEFAULT_AI_MODEL


def normalize_ai_cache_key(description: str) -> str:
    lowered = description.lower()
    lowered = re.sub(r"\b\d{2,}\b", " ", lowered)
    lowered = re.sub(r"\b\d{1,2}\s+[a-z]{3,9}\b", " ", lowered)
    lowered = re.sub(r"\d+[.,]\d{2}\s*(cr|dr)?", " ", lowered)
    lowered = re.sub(r"[^a-z#* ]+", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered[:160]


def ai_diagnostics(enabled: bool | None = None) -> dict[str, Any]:
    return {
        "ai_enabled": bool(os.getenv("OPENAI_API_KEY")) if enabled is None else enabled,
        "ai_model": accounting_ai_model(),
        "ai_transactions_sent": 0,
        "ai_transactions_classified": 0,
        "ai_failures": 0,
        "ai_cache_hits": 0,
    }


def row_needs_ai(row: dict[str, Any]) -> bool:
    description = str(row.get("description") or "").lower()
    account = str(row.get("account") or "")
    group = str(row.get("group") or "")
    confidence = float(row.get("rule_confidence") or 0)
    money_in = decimal_amount(row.get("money_in"))
    money_out = decimal_amount(row.get("money_out"))
    if account == "Bank Charges" and confidence >= 94:
        return False
    return (
        bool(row.get("review_required"))
        or confidence < 94
        or row.get("vat_claim_status") in {"Review", "Output/Review"}
        or account in {
            "Unclassified Expense",
            "Review Required",
            "Review Required Suspense",
            "Meals / Groceries - Non Deductible Review",
            "Other Income / Review",
            "Suspense / Review Required",
            "Related Party / Drawings",
            "Revenue Review",
            "Operating Expenses",
            "Supplier Payments",
        }
        or group in {"Review", "Operating Expenses", "Income", "Meals/Groceries", "Payroll/Personal"}
        or money_in >= Decimal("5000.00")
        or money_out >= Decimal("5000.00")
        or any(token in description for token in ("app payment to", "app rtc pmt to", "magtape credit", "gp hea", "department of health", "rmsp trading", "stalitrex", "nms enterprises", "uber eats", "spa", "puppy", "photography", "sloppy kisses", "senses spa", "adore", "afrigreen", "freight aces", "naicker"))
    )


def mark_possible_duplicates(rows: list[dict[str, Any]]) -> None:
    seen: dict[tuple[str, Decimal, Decimal], int] = {}
    for row in rows:
        key = (
            normalize_ai_cache_key(str(row.get("description") or "")),
            decimal_amount(row.get("money_in")),
            decimal_amount(row.get("money_out")),
        )
        seen[key] = seen.get(key, 0) + 1
    for row in rows:
        key = (
            normalize_ai_cache_key(str(row.get("description") or "")),
            decimal_amount(row.get("money_in")),
            decimal_amount(row.get("money_out")),
        )
        if seen.get(key, 0) > 1 and (decimal_amount(row.get("money_in")) > 0 or decimal_amount(row.get("money_out")) > 0):
            reason = row.get("review_reason") or ""
            row["review_reason"] = "; ".join(part for part in [reason, "Possible duplicate"] if part)
            row["review_required"] = True


def ai_safe_item(row: dict[str, Any], transaction_id: str) -> dict[str, Any]:
    return {
        "transaction_id": transaction_id,
        "date": str(row.get("date") or ""),
        "description": str(row.get("description") or "")[:260],
        "money_in": str(decimal_amount(row.get("money_in"))),
        "money_out": str(decimal_amount(row.get("money_out"))),
        "rule_account": str(row.get("account") or ""),
        "rule_group": str(row.get("group") or ""),
        "rule_vat_treatment": str(row.get("vat_treatment") or ""),
        "rule_vat_claim_status": str(row.get("vat_claim_status") or ""),
        "rule_confidence": float(row.get("rule_confidence") or 0),
        "rule_reason": str(row.get("classification_reason") or ""),
    }


def parse_ai_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1"}
    return bool(value)


def validate_ai_item(item: Any, valid_ids: set[str]) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    transaction_id = str(item.get("transaction_id") or "")
    if transaction_id not in valid_ids:
        return None
    account = str(item.get("account") or "").strip()[:80]
    group = str(item.get("group") or "").strip()[:80]
    vat_treatment = str(item.get("vat_treatment") or "").strip()[:80]
    vat_claim_status = str(item.get("vat_claim_status") or "").strip()[:80]
    if not account or not group or not vat_treatment or not vat_claim_status:
        return None
    try:
        confidence = float(item.get("confidence"))
    except Exception:
        confidence = 0.6
    if confidence > 1:
        confidence = confidence / 100
    confidence = min(max(confidence, 0), 1)
    return {
        "transaction_id": transaction_id,
        "account": account,
        "group": group,
        "vat_treatment": vat_treatment,
        "vat_claim_status": vat_claim_status,
        "review_required": parse_ai_bool(item.get("review_required")),
        "review_reason": str(item.get("review_reason") or "").strip()[:220],
        "invoice_required": parse_ai_bool(item.get("invoice_required")),
        "confidence": confidence,
        "reason": str(item.get("reason") or "").strip()[:220],
        "explanation": str(item.get("explanation") or "").strip()[:320],
    }


def parse_ai_json_content(content: str) -> Any:
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE).strip()
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(cleaned[start : end + 1])
    return parsed


def request_ai_classifications(items: list[dict[str, Any]], diagnostics: dict[str, Any]) -> list[dict[str, Any]]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key or not items:
        return []

    prompt = {
        "instructions": (
            "Classify South African business bank statement transactions for accounting review. "
            "Return strict JSON only. Do not infer amounts, balances, dates, or reconciliation. "
            "Use conservative VAT treatment. Mark ambiguous, personal-looking, entertainment, or supplier-unknown items for review. "
            "Do not classify purely because a generic keyword appears in the description. Use merchant semantics, recurring pattern, amount direction, known supplier context, and the existing rule result. "
            "The account holder / company name printed on the statement is context, not a merchant. Never classify a row into a category merely because the account holder's own name appears in the description."
        ),
        "known_supplier_guidance": [
            {"merchant": "Discovery", "account": "Insurance", "reason": "Previously approved insurance supplier pattern."},
            {"merchant": "FNB service fees or BYC debit", "account": "Bank Charges", "reason": "Bank fee pattern from FNB statement."},
            {"merchant": "Google ChatGPT/OpenAI", "account": "Software Subscriptions", "reason": "Software subscription merchant pattern."},
            {"merchant": "DHL/Paygate DHL", "account": "Courier / Freight", "reason": "Courier merchant pattern."},
            {"merchant": "Payroll, nanny, caregiver, salary", "account": "Salaries / Drawings / Personal", "reason": "Payroll/personnel payment pattern."},
            {"merchant": "Diesel, Engen, Shell, Sasol, Volvo or toll operators", "account": "Motor Vehicle Expenses / Road Tolls", "reason": "Recurring fleet and transport operating costs."},
            {"merchant": "Afrigreen or customer-name EFT credits", "account": "Sales / Revenue", "reason": "Inbound customer receipt pattern when money is received."},
            {"merchant": "Medical aid, Discovery Health, Momentum Health, Medshield or Bonitas", "account": "Salaries / Drawings / Personal", "reason": "Payroll-linked medical deduction pattern."},
            {"merchant": "Loans, WesBank or vehicle finance instalments", "account": "Loan / Liability", "reason": "Balance-sheet loan servicing pattern."},
            {"merchant": "Sage SA or Sage Accounting", "account": "Software Subscriptions", "reason": "Accounting software subscription pattern."},
            {"merchant": "Scheduled home loan, savings, credit card or own-account transfers", "account": "Loan / Liability or Inter-account Transfer", "reason": "Balance-sheet movement; not VAT or P&L."},
            {"merchant": "Netcash, Stratum or Disc Prem debit orders", "account": "Operating Expenses", "reason": "Recurring debit-order supplier, but support is required before VAT is claimed."},
            {"merchant": "Acapolite Accounting, bookkeeping or audit fees", "account": "Accounting / Professional Fees", "reason": "Professional services supplier, invoice support required."},
            {"merchant": "Magtape Credit 047-GP HEA / Gauteng Department of Health / Department of Health", "account": "Sales / Revenue", "reason": "Inbound government or tender/service receipt. Treat as taxable service revenue unless marked exempt by the accountant."},
            {"merchant": "MSI Industries, RMSP Trading, Stalitrex, NMS Enterprises, JC Industries, First Works, Midway, Fabric And Leather, or other clear company-name/invoice payments", "account": "Supplier Payments", "reason": "Outbound payment to a business supplier. Do not classify as staff welfare merely because Allianz Holdings appears in the reference."},
            {"merchant": "Senses Spa, Sloppy Kisses, Puppy Classes, Prayer Shop, hair or pharmacy purchases", "account": "Staff Welfare / Meals / Entertainment or Review Required", "reason": "Personal-looking or welfare supplier; keep review required unless user-approved."},
        ],
        "classification_policy": [
            "Money In from a customer, tender, department, province, municipality, GP Health, Department of Health, or Magtape Credit must normally be Sales / Revenue with Output VAT review/standard treatment.",
            "Money Out to a registered-looking company name, supplier name, or description containing Industries, Trading, Enterprises, Services, Invoice, or Inv must normally be Supplier Payments or Operating Expenses with invoice support required, not Staff Welfare.",
            "Large outbound payments above 5,000 require stronger business-context review. Never classify a large invoice/company payment as meals, entertainment, travel, or staff welfare unless the merchant itself is clearly food, restaurant, catering, personal care, or entertainment.",
            "Use Staff Welfare / Meals / Entertainment only for food, groceries, restaurant, personal care, entertainment, or welfare merchants.",
            "If the description contains the account holder name, ignore that account-holder wording and classify by the counterparty/merchant semantics.",
            "If a supplier is business-like but the exact expense nature is unclear, choose Supplier Payments, VAT review, invoice_required true, review_required true, and explain what invoice/support is needed.",
        ],
        "schema": {
            "items": [
                {
                    "transaction_id": "string",
                    "account": "string",
                    "group": "string",
                    "vat_treatment": "string",
                    "vat_claim_status": "string",
                    "review_required": True,
                    "review_reason": "string",
                    "invoice_required": True,
                    "confidence": 0.72,
                    "reason": "string",
                    "explanation": "string",
                }
            ]
        },
        "transactions": items,
    }
    body = {
        "model": accounting_ai_model(),
        "temperature": 0,
        "max_tokens": 6000,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": "You are an accounting classification assistant. Output valid JSON only."},
            {"role": "user", "content": json.dumps(prompt, default=str)},
        ],
    }

    def send_openai_request(request_body: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(request_body).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))

    try:
        try:
            payload = send_openai_request(body)
        except urllib.error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            if exc.code != 400:
                raise
            log_warning("worker.ai_classification_retrying_without_response_format", status=exc.code, body=body_text[:1200])
            fallback_body = {key: value for key, value in body.items() if key != "response_format"}
            payload = send_openai_request(fallback_body)
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        parsed = parse_ai_json_content(content)
        valid_ids = {str(item["transaction_id"]) for item in items}
        if isinstance(parsed, dict):
            raw_items = parsed.get("items", [])
        elif isinstance(parsed, list):
            raw_items = parsed
        else:
            raw_items = []
        if isinstance(raw_items, dict):
            raw_items = list(raw_items.values())
        elif not isinstance(raw_items, list):
            raw_items = []
        validated_items = [validated for raw in raw_items if (validated := validate_ai_item(raw, valid_ids))]
        if not validated_items and items:
            diagnostics["ai_failures"] += 1
            log_warning("worker.ai_classification_empty", returned_keys=list(parsed.keys()) if isinstance(parsed, dict) else [], item_count=len(items))
        return validated_items
    except urllib.error.HTTPError as exc:
        diagnostics["ai_failures"] += 1
        body_text = exc.read().decode("utf-8", errors="replace")
        log_warning("worker.ai_classification_http_failed", status=exc.code, body=body_text[:1200])
    except Exception as exc:
        diagnostics["ai_failures"] += 1
        log_warning("worker.ai_classification_failed", error=str(exc))
    return []


def apply_ai_result_to_row(row: dict[str, Any], result: dict[str, Any]) -> None:
    description = str(row.get("description") or "")
    money_out = decimal_amount(row.get("money_out"))
    ai_account_text = f"{result.get('account', '')} {result.get('group', '')}".lower()
    if (
        money_out > 0
        and any(token in ai_account_text for token in ("staff welfare", "meal", "entertainment", "travel"))
        and not is_staff_welfare_merchant(description)
    ):
        if looks_like_business_supplier_payment(description):
            result = {
                **result,
                "account": "Supplier Payments",
                "group": "Operating Expenses",
                "vat_treatment": "Input VAT if valid invoice",
                "vat_claim_status": "Input/Review",
                "review_required": True,
                "review_reason": "Business supplier payment requires invoice and VAT review.",
                "invoice_required": True,
                "confidence": min(float(result.get("confidence") or 0.72), 0.88),
                "reason": "Guardrail applied: company/invoice supplier pattern overrides staff welfare.",
                "explanation": "The description looks like a business supplier or invoice payment, so it must not be classified as meals or entertainment without explicit accountant approval.",
            }
        else:
            result = {
                **result,
                "account": "Review Required Suspense",
                "group": "Review",
                "vat_treatment": "Review",
                "vat_claim_status": "Review",
                "review_required": True,
                "review_reason": "AI suggested staff welfare without a recognised food, personal-care, or entertainment merchant.",
                "invoice_required": True,
                "confidence": min(float(result.get("confidence") or 0.62), 0.70),
                "reason": "Guardrail applied: staff welfare requires a matching merchant pattern.",
                "explanation": "The transaction needs accountant review before it can be treated as staff welfare, meals, entertainment, or travel.",
            }
    row["account"] = result["account"]
    row["group"] = result["group"]
    row["vat_treatment"] = result["vat_treatment"]
    row["vat_claim_status"] = result["vat_claim_status"]
    ai_confidence = float(result["confidence"])
    review_required = bool(result["review_required"])
    review_reason = result["review_reason"] or ""
    if (
        not review_required
        and ai_confidence >= 0.82
        and result["account"] not in {"Unclassified Expense", "Other Income / Review", "Review Required", "Review Required Suspense", "Suspense / Review Required"}
        and result["vat_claim_status"] not in {"Review", "Output/Review"}
    ):
        review_reason = ""
    row["review_required"] = review_required
    row["review_reason"] = review_reason
    row["invoice_required"] = result["invoice_required"]
    row["ai_confidence"] = ai_confidence
    row["classification_reason"] = result.get("reason") or row.get("classification_reason") or "AI classification applied to ambiguous transaction."
    row["classification_explanation"] = result.get("explanation") or row.get("classification_explanation") or ""
    row["ai_used"] = True
    recompute_professional_vat(row)


def apply_ai_classifications(rows: list[dict[str, Any]]) -> dict[str, Any]:
    diagnostics = ai_diagnostics()
    if not diagnostics["ai_enabled"]:
        return diagnostics

    batch: list[dict[str, Any]] = []
    row_by_id: dict[str, dict[str, Any]] = {}
    cache_key_by_id: dict[str, str] = {}

    for index, row in enumerate(rows, start=1):
        if not row_needs_ai(row):
            continue
        cache_key = normalize_ai_cache_key(str(row.get("description") or ""))
        if cache_key and cache_key in AI_CLASSIFICATION_CACHE:
            apply_ai_result_to_row(row, AI_CLASSIFICATION_CACHE[cache_key])
            diagnostics["ai_cache_hits"] += 1
            continue
        transaction_id = str(index)
        batch.append(ai_safe_item(row, transaction_id))
        row_by_id[transaction_id] = row
        cache_key_by_id[transaction_id] = cache_key

    diagnostics["ai_transactions_sent"] = len(batch)
    for start in range(0, len(batch), AI_CLASSIFICATION_BATCH_SIZE):
        chunk = batch[start : start + AI_CLASSIFICATION_BATCH_SIZE]
        for result in request_ai_classifications(chunk, diagnostics):
            row = row_by_id.get(result["transaction_id"])
            if not row:
                continue
            apply_ai_result_to_row(row, result)
            cache_key = cache_key_by_id.get(result["transaction_id"])
            if cache_key:
                AI_CLASSIFICATION_CACHE[cache_key] = result
            diagnostics["ai_transactions_classified"] += 1

    log_event("worker.ai_classification", **diagnostics)
    return diagnostics


def month_summary(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    months = sorted({row["month"] for row in rows if row["month"]})
    summary = []
    for month in months:
        matching = [row for row in rows if row["month"] == month]
        receipts = sum((row["money_in"] for row in matching), Decimal("0.00")).quantize(CENT)
        payments = sum((row["money_out"] for row in matching), Decimal("0.00")).quantize(CENT)
        likely_sales = sum((row["money_in"] for row in matching if row["vat_claim_status"].startswith("Output")), Decimal("0.00")).quantize(CENT)
        cos = sum((row["money_out"] for row in matching if reporting_account(row) != "Review Required Suspense" and row["group"] in {"Freight", "Software/IT"}), Decimal("0.00")).quantize(CENT)
        output_vat = sum((row["potential_output_vat"] for row in matching if reporting_account(row) != "Review Required Suspense"), Decimal("0.00")).quantize(CENT)
        input_vat = sum((row["potential_input_vat"] for row in matching if reporting_account(row) != "Review Required Suspense"), Decimal("0.00")).quantize(CENT)
        summary.append({
            "month": month,
            "receipts": receipts,
            "payments": payments,
            "likely_sales": likely_sales,
            "cos": cos,
            "output_vat": output_vat,
            "input_vat": input_vat,
            "vat_payable": (output_vat - input_vat).quantize(CENT),
        })
    return summary


def write_vat_schedule_sheet(workbook: Workbook, rows: list[dict[str, Any]], include_source_period: bool = False):
    vat = workbook.create_sheet("VAT Schedule")
    reportable_rows = [row for row in rows if reporting_account(row) != "Review Required Suspense"]
    total_output_vat = sum((row["potential_output_vat"] for row in reportable_rows), Decimal("0.00")).quantize(CENT)
    total_input_vat = sum((row["potential_input_vat"] for row in reportable_rows), Decimal("0.00")).quantize(CENT)
    net_vat = (total_output_vat - total_input_vat).quantize(CENT)
    review_items = sum(1 for row in rows if reporting_account(row) == "Review Required Suspense" or reporting_vat_status(row) == "Review")
    vat["A1"] = "VAT Schedule & VAT Payable/(Refund)"
    vat["A1"].font = Font(bold=True, size=14, color="FFFFFF")
    vat["A1"].fill = HEADER_FILL
    vat.merge_cells("A1:K1")
    vat["A2"] = "VAT is calculated at 15/115 on VAT-inclusive transactions only where the category and VAT treatment are reportable. Review-required rows stay visible but are excluded from VAT totals until approved."
    vat["A2"].font = Font(italic=True, size=9, color="475569")
    vat["A2"].alignment = Alignment(wrap_text=True)

    write_row(vat, ["VAT Summary", "Output VAT", "Input VAT", "VAT Payable/(Refund)", "Review Items"], 4, header=True)
    write_row(vat, ["Totals", total_output_vat, total_input_vat, net_vat, review_items], 5)
    for column_index in range(2, 5):
        vat.cell(row=5, column=column_index).number_format = CURRENCY_FORMAT
    vat.cell(row=5, column=4).fill = PASS_FILL if net_vat <= 0 else FAIL_FILL
    vat.cell(row=5, column=5).number_format = "0"

    monthly_rows = month_summary(reportable_rows)
    write_row(vat, ["Month", "Output VAT", "Input VAT", "Net VAT Payable/(Refund)", "Running VAT Balance", "Status"], 7, header=True)
    running_balance = Decimal("0.00")
    for row_index, month_row in enumerate(monthly_rows, start=8):
        monthly_net = month_row["vat_payable"]
        running_balance = (running_balance + monthly_net).quantize(CENT)
        write_row(
            vat,
            [
                month_row["month"],
                month_row["output_vat"],
                month_row["input_vat"],
                monthly_net,
                running_balance,
                "Payable" if running_balance >= 0 else "Refundable",
            ],
            row_index,
        )
        for column_index in range(2, 6):
            vat.cell(row=row_index, column=column_index).number_format = CURRENCY_FORMAT

    detail_header_row = max(10, 9 + len(monthly_rows))
    detail_headers = ["Date", "Description", "Money In", "Money Out", "Account", "VAT Treatment", "Claim Status", "Output VAT", "Input VAT", "Net VAT", "VAT Balance", "Document Status"]
    if include_source_period:
        detail_headers.insert(2, "Source Period")
    write_row(vat, detail_headers, detail_header_row, header=True)
    running_line_vat = Decimal("0.00")
    for row_index, row in enumerate(rows, start=detail_header_row + 1):
        is_reportable = reporting_account(row) != "Review Required Suspense"
        output_vat = row["potential_output_vat"] if is_reportable else Decimal("0.00")
        input_vat = row["potential_input_vat"] if is_reportable else Decimal("0.00")
        line_net = (output_vat - input_vat).quantize(CENT)
        running_line_vat = (running_line_vat + line_net).quantize(CENT)
        values = [
            row["date"],
            row["description"],
            row["money_in"],
            row["money_out"],
            reporting_account(row),
            row["vat_treatment"],
            reporting_vat_status(row),
            output_vat,
            input_vat,
            line_net,
            running_line_vat,
            "Tax invoice to be matched by user" if is_reportable else "Review before VAT is included",
        ]
        if include_source_period:
            values.insert(2, row["source_period"])
        write_row(vat, values, row_index)

    currency_columns = [3, 4, 8, 9, 10, 11] if include_source_period else [3, 4, 8, 9, 10, 11]
    if include_source_period:
        currency_columns = [4, 5, 9, 10, 11, 12]
    apply_number_formats(vat, currency_columns)
    return vat, detail_header_row, len(detail_headers)


def build_workbook(metadata: dict[str, Any], transactions: list[ParsedTransaction], allow_ai: bool = True) -> bytes:
    workbook = Workbook()
    totals = validation_summary(transactions)
    status, calculated_closing = validation_status(metadata, transactions)
    opening = decimal_amount(metadata.get("opening_balance"))
    closing = decimal_amount(metadata.get("closing_balance"))
    # Use the company/account holder detected from the actual statement. Never
    # hardcode a company name into the workbook title.
    company_name = (metadata.get("company_name") or "").strip()
    account_number = (metadata.get("account_number") or "").strip()
    source_file = metadata.get("source_file") or ""
    rows = [professional_transaction_row(transaction, source_file) for transaction in transactions]
    ai_started = time.perf_counter()
    if allow_ai:
        ai_stats = apply_ai_classifications(rows)
    else:
        ai_stats = ai_diagnostics(enabled=bool(os.getenv("OPENAI_API_KEY")))
        ai_stats["ai_skipped"] = "extraction_incomplete"
    ai_duration_ms = round((time.perf_counter() - ai_started) * 1000, 2)
    ai_stats["ai_classification_duration_ms"] = ai_duration_ms
    log_event("worker.ai_classification_duration", duration_ms=ai_duration_ms, parser_profile=WORKER_PARSER_VERSION)
    mark_possible_duplicates(rows)
    metadata["_ai_diagnostics"] = ai_stats
    months = month_summary(rows)
    bank_charge_total = sum((row["bank_charge"] for row in rows), Decimal("0.00")).quantize(CENT)
    bank_vat = (bank_charge_total * Decimal("15") / Decimal("115")).quantize(CENT)
    reportable_rows = [row for row in rows if reporting_account(row) != "Review Required Suspense"]
    total_output_vat = sum((row["potential_output_vat"] for row in reportable_rows), Decimal("0.00")).quantize(CENT)
    total_input_vat = sum((row["potential_input_vat"] for row in reportable_rows), Decimal("0.00")).quantize(CENT)

    dashboard = workbook.active
    dashboard.title = "Dashboard"
    dashboard.merge_cells("A1:K1")
    workbook_title = (
        f"{company_name} - Bank Statement Accounting Pack"
        if company_name
        else "Bank Statement Accounting Pack"
    )
    dashboard["A1"] = workbook_title
    dashboard["A1"].font = Font(bold=True, size=14, color="FFFFFF")
    dashboard["A1"].fill = HEADER_FILL
    dashboard["A1"].alignment = Alignment(horizontal="center")
    dashboard.merge_cells("A2:K2")
    dashboard["A2"] = ACCOUNTING_REPORT_DISCLAIMER
    dashboard["A2"].font = Font(italic=True, size=9, color="475569")
    dashboard["A2"].alignment = Alignment(wrap_text=True)
    dashboard_rows = [
        ("Period covered", f"{metadata.get('statement_period_start') or '-'} to {metadata.get('statement_period_end') or '-'}"),
        ("Opening bank balance", opening),
        ("Total receipts", totals["total_credits"]),
        ("Total payments", totals["total_debits"]),
        ("Closing bank balance", closing),
        ("Bank movement check", (opening + totals["total_credits"] - totals["total_debits"] - closing).quantize(CENT)),
        ("Likely taxable revenue receipts", sum((row["money_in"] for row in reportable_rows if row["vat_claim_status"].startswith("Output")), Decimal("0.00")).quantize(CENT)),
        ("Potential output VAT", total_output_vat),
        ("Potential input VAT (review)", total_input_vat),
        ("Potential VAT payable/(refund)", (total_output_vat - total_input_vat).quantize(CENT)),
        ("Transactions extracted", len(transactions)),
        ("Reconciliation status", "Reconciled" if status == "PASSED" else "Review required"),
    ]
    for index, row in enumerate(dashboard_rows, start=3):
        write_row(dashboard, list(row), index)
    dashboard["B14"].fill = PASS_FILL if status == "PASSED" else FAIL_FILL
    dashboard["B14"].font = Font(bold=True, color="166534" if status == "PASSED" else "991B1B")
    write_row_at(dashboard, ["Month", "Receipts", "Payments", "Likely Sales", "COS/Subcontractors", "Output VAT", "Input VAT", "VAT Payable/(Refund)"], 3, 4, header=True)
    for row_index, month_row in enumerate(months, start=4):
        write_row_at(
            dashboard,
            [month_row["month"], month_row["receipts"], month_row["payments"], month_row["likely_sales"], month_row["cos"], month_row["output_vat"], month_row["input_vat"], month_row["vat_payable"]],
            row_index,
            4,
        )
    for row_index in range(4, 13):
        dashboard.cell(row=row_index, column=2).number_format = CURRENCY_FORMAT
        for column_index in range(5, 12):
            dashboard.cell(row=row_index, column=column_index).number_format = CURRENCY_FORMAT
    dashboard["B13"].number_format = "0"

    tx = workbook.create_sheet("Transactions")
    transaction_headers = [
        "Date", "Month", "Description", "Money In", "Money Out", "Amount", "Type", "Balance", "Bank Charge",
        "Account", "Group", "VAT Treatment", "VAT Claim Status", "Potential Output VAT", "Potential Input VAT",
        "Confidence", "Classification Reason", "Classification Explanation",
    ]
    write_row(tx, transaction_headers, 1, header=True)
    for row_index, row in enumerate(rows, start=2):
        write_row(
            tx,
            [
                row["date"], row["month"], row["description"], row["money_in"], row["money_out"], row["amount"], row["type"], row["balance"],
                row["bank_charge"], row["account"], row["group"], row["vat_treatment"], row["vat_claim_status"], row["potential_output_vat"],
                row["potential_input_vat"], row["rule_confidence"], row["classification_reason"], row["classification_explanation"],
            ],
            row_index,
        )
    apply_number_formats(tx, [4, 5, 6, 8, 9, 14, 15])

    vat, vat_detail_header_row, vat_column_count = write_vat_schedule_sheet(workbook, rows)

    ledger = workbook.create_sheet("General Ledger")
    write_row(ledger, ["Date", "Description", "Account", "Debit", "Credit"], 1, header=True)
    gl_row = 2
    write_row(ledger, [workbook_date(metadata.get("statement_period_start")), "Opening balance per bank statement", "Bank", opening, Decimal("0.00")], gl_row)
    gl_row += 1
    write_row(ledger, [workbook_date(metadata.get("statement_period_start")), "Opening balance per bank statement", "Opening Equity / Prior Periods", Decimal("0.00"), opening], gl_row)
    gl_row += 1
    for row in rows:
        if row["money_out"] > 0:
            write_row(ledger, [row["date"], row["description"], reporting_account(row), row["money_out"], Decimal("0.00")], gl_row)
            gl_row += 1
            write_row(ledger, [row["date"], row["description"], "Bank", Decimal("0.00"), row["money_out"]], gl_row)
            gl_row += 1
        elif row["money_in"] > 0:
            write_row(ledger, [row["date"], row["description"], "Bank", row["money_in"], Decimal("0.00")], gl_row)
            gl_row += 1
            write_row(ledger, [row["date"], row["description"], reporting_account(row), Decimal("0.00"), row["money_in"]], gl_row)
            gl_row += 1
    apply_number_formats(ledger, [4, 5])

    trial = workbook.create_sheet("Trial Balance")
    write_row(trial, ["Account", "Total Debits", "Total Credits", "Debit Balance", "Credit Balance"], 1, header=True)
    ledger_accounts = sorted({ledger.cell(row=row, column=3).value for row in range(2, ledger.max_row + 1) if ledger.cell(row=row, column=3).value})
    for row_index, account in enumerate(ledger_accounts, start=2):
        debits = sum(decimal_amount(ledger.cell(row=row, column=4).value) for row in range(2, ledger.max_row + 1) if ledger.cell(row=row, column=3).value == account)
        credits = sum(decimal_amount(ledger.cell(row=row, column=5).value) for row in range(2, ledger.max_row + 1) if ledger.cell(row=row, column=3).value == account)
        net = (debits - credits).quantize(CENT)
        write_row(trial, [account, debits, credits, net if net > 0 else Decimal("0.00"), abs(net) if net < 0 else Decimal("0.00")], row_index)
    total_row = len(ledger_accounts) + 2
    write_row(
        trial,
        [
            "Totals",
            f"=SUM(B2:B{total_row - 1})",
            f"=SUM(C2:C{total_row - 1})",
            f"=SUM(D2:D{total_row - 1})",
            f"=SUM(E2:E{total_row - 1})",
        ],
        total_row,
    )
    write_row(
        trial,
        ["Balance Check", "", "", f"=D{total_row}-E{total_row}", "Balanced when zero"],
        total_row + 1,
    )
    for cell in trial[total_row]:
        cell.font = Font(bold=True)
    apply_number_formats(trial, [2, 3, 4, 5])

    rec = workbook.create_sheet("Bank Rec")
    write_row(rec, ["Bank Reconciliation", "Amount"], 1, header=True)
    rec_rows = [
        ("Opening Balance", opening),
        ("+ Receipts", totals["total_credits"]),
        ("- Payments", totals["total_debits"]),
        ("Expected Closing Balance", "=B2+B3-B4"),
        ("Statement Closing Balance", closing),
        ("Difference", f"=B5-B6"),
        ("Status", '=IF(B7=0,"Reconciled","Review required")'),
        ("Service Fees", bank_charge_total),
        ("Bank VAT", bank_vat),
    ]
    for row_index, row in enumerate(rec_rows, start=2):
        write_row(rec, list(row), row_index)
    rec["B8"].fill = PASS_FILL if status == "PASSED" else FAIL_FILL
    rec["B8"].font = Font(bold=True, color="166534" if status == "PASSED" else "991B1B")
    apply_number_formats(rec, [2])

    review = workbook.create_sheet("Review Items")
    write_row(review, ["Date", "Description", "Money In", "Money Out", "Account", "Group", "VAT Claim Status", "Reason", "Invoice Required"], 1, header=True)
    review_row = 2
    for row in rows:
        reason = row.get("review_reason") or professional_review_reason(row)
        if row.get("review_required") or reporting_account(row) == "Review Required Suspense":
            write_row(
                review,
                [
                    row["date"],
                    row["description"],
                    row["money_in"],
                    row["money_out"],
                    row["account"],
                    row["group"],
                    row["vat_claim_status"],
                    reason or "Review recommended",
                    "Yes" if row.get("invoice_required") else "No",
                ],
                review_row,
            )
            review_row += 1
    apply_number_formats(review, [3, 4])

    assumptions = workbook.create_sheet("Assumptions")
    assumptions_rows = [
        ("Area", "Assumption / Note"),
        ("Report limitation", ACCOUNTING_REPORT_DISCLAIMER),
        ("Important limitation", "This workbook is prepared from bank statements only. It is a cashbook-based reconstruction, not a full accounting system TB."),
        ("VAT rule applied", "Potential VAT is calculated at 15/115 of VAT-inclusive amounts only where the bank description suggests taxable revenue or claimable input VAT."),
        ("Invoice matching", "User confirmed invoices will be handled separately. The VAT schedule therefore flags document status for invoice matching."),
        ("Personal / non-deductible items", "Meals, groceries, spa, pets, gifts, entertainment and similar items are flagged for review and generally should not be claimed without strong business evidence."),
        ("Transfers", "Savings, investment, credit card and home loan transfers are treated as inter-account transfers/loan movements, not VAT transactions."),
        ("Bank fees", "FNB bank VAT per statement has been included in the reconciliation sheet. Individual bank charge VAT is flagged as review where applicable."),
        ("Bank account", f"FNB Platinum Business Account ending {account_number[-4:]}."),
        ("AI-assisted classification", "Where enabled, ambiguous descriptions may be classified by AI after the deterministic parser and reconciliation checks pass. Rule-based classifications remain the fallback."),
        ("Next step", "Match each VAT line to the relevant tax invoice, then update claim status before VAT201 submission."),
    ]
    for row_index, row in enumerate(assumptions_rows, start=1):
        write_row(assumptions, list(row), row_index, header=row_index == 1)

    finish_sheet(dashboard, freeze_pane="D4")
    finish_sheet(tx, filter_ref=f"A1:R{max(tx.max_row, 1)}")
    finish_sheet(vat, freeze_pane=f"A{vat_detail_header_row + 1}", filter_ref=f"A{vat_detail_header_row}:{get_column_letter(vat_column_count)}{max(vat.max_row, vat_detail_header_row)}")
    finish_sheet(ledger, filter_ref=f"A1:E{max(ledger.max_row, 1)}")
    finish_sheet(trial, filter_ref=f"A1:E{max(len(ledger_accounts) + 1, 1)}")
    finish_sheet(rec)
    finish_sheet(review, filter_ref=f"A1:I{max(review.max_row, 1)}")
    finish_sheet(assumptions)

    output = io.BytesIO()
    validate_workbook_for_export(workbook)
    workbook.save(output)
    return output.getvalue()


def parsed_transaction_from_row(row: dict[str, Any]) -> ParsedTransaction:
    return ParsedTransaction(
        transaction_date=row.get("transaction_date"),
        description=str(row.get("description") or ""),
        debit_amount=float(row["debit_amount"]) if row.get("debit_amount") is not None else None,
        credit_amount=float(row["credit_amount"]) if row.get("credit_amount") is not None else None,
        running_balance=float(row["running_balance"]) if row.get("running_balance") is not None else None,
        bank_charge=bool(row.get("bank_charge")),
        account_category=str(row.get("account_category") or "Uncategorised"),
        vat_treatment=str(row.get("vat_treatment") or "review"),
        supported_by_invoice=bool(row.get("supported_by_invoice")),
        notes=str(row.get("notes") or ""),
        confidence=float(row.get("confidence") or 0),
        review_status=str(row.get("review_status") or "needs_review"),
        source_page=row.get("source_page"),
        source_row=row.get("source_row"),
        raw_text=row.get("raw_text"),
    )


def transaction_insert_row(transaction: ParsedTransaction, run_id: str, workspace_id: str) -> dict[str, Any]:
    row = {
        **transaction.model_dump(),
        "run_id": run_id,
        "workspace_id": workspace_id,
    }
    # source_row is useful for in-memory ordering/deduping, but older production
    # databases do not have this optional column yet. Keep writes compatible.
    row.pop("source_row", None)
    return row


def run_period_label(run: dict[str, Any]) -> str:
    start = str(run.get("statement_period_start") or "")
    end = str(run.get("statement_period_end") or "")
    if start and end:
        return f"{start} to {end}"
    return start or end or "Unknown period"


def combine_duplicate_key(transaction: ParsedTransaction) -> tuple[str, str, str, str, str]:
    return (
        str(transaction.transaction_date or ""),
        normalize_merchant_key(transaction.description),
        str(decimal_amount(transaction.debit_amount)),
        str(decimal_amount(transaction.credit_amount)),
        str(decimal_amount(transaction.running_balance)),
    )


def combine_fingerprint(run: dict[str, Any], transaction: ParsedTransaction, fallback_row: int) -> tuple[str, str, str, str, str, str, str, str, str]:
    return (
        str(run.get("account_number") or "").strip().lower(),
        str(run.get("id") or "").strip().lower(),
        str(transaction.transaction_date or ""),
        normalize_merchant_key(transaction.description),
        str(decimal_amount(transaction.debit_amount)),
        str(decimal_amount(transaction.credit_amount)),
        str(decimal_amount(transaction.running_balance)),
        str(transaction.source_page or 0),
        str(transaction.source_row or fallback_row),
    )


def extract_transaction_time(raw_text: str | None) -> str:
    if not raw_text:
        return ""
    match = re.search(r"\b([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b", raw_text)
    if not match:
        return ""
    second = match.group(3) or "00"
    return f"{match.group(1)}:{match.group(2)}:{second}"


def parse_iso_date_or_max(value: str | None) -> date:
    if not value:
        return date.max
    try:
        return date.fromisoformat(value)
    except ValueError:
        return date.max


def continuity_state(previous_closing: float | None, next_opening: float | None) -> tuple[str, Decimal | None]:
    if previous_closing is None or next_opening is None:
        return "UNKNOWN", None
    previous_decimal = decimal_amount(previous_closing)
    next_decimal = decimal_amount(next_opening)
    difference = (next_decimal - previous_decimal).quantize(CENT)
    if difference == 0:
        return "PASSED", Decimal("0.00")
    return "FAILED", difference


def continuity_failure_message(continuity: list[dict[str, Any]]) -> str:
    failures = [
        item
        for item in continuity
        if item.get("status") in {"FAILED", "UNKNOWN"}
    ]
    if not failures:
        return ""
    parts = []
    for item in failures:
        parts.append(
            f"{item['previous_period']} -> {item['next_period']}: {item['status']}"
        )
    return "Continuity checks require review: " + "; ".join(parts)


def run_continuity_summary(runs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str, str]:
    sorted_runs = sorted(runs, key=lambda run: str(run.get("statement_period_start") or run.get("created_at") or ""))
    continuity: list[dict[str, Any]] = []
    for previous, current in zip(sorted_runs, sorted_runs[1:]):
        state, diff = continuity_state(previous.get("closing_balance"), current.get("opening_balance"))
        continuity.append(
            {
                "previous_period": run_period_label(previous),
                "next_period": run_period_label(current),
                "previous_closing": decimal_amount(previous.get("closing_balance")) if previous.get("closing_balance") is not None else None,
                "next_opening": decimal_amount(current.get("opening_balance")) if current.get("opening_balance") is not None else None,
                "status": state,
                "difference": diff,
            }
        )

    continuity_passed = all(item["status"] == "PASSED" for item in continuity)
    continuity_failed = any(item["status"] == "FAILED" for item in continuity)
    continuity_result = "PASSED" if continuity_passed else "FAILED" if continuity_failed else "UNKNOWN"
    return continuity, continuity_result, continuity_failure_message(continuity)


def validate_combine_runs(runs: list[dict[str, Any]], payload: CombineRequest) -> list[dict[str, Any]]:
    if len(runs) != len(set(payload.run_ids)):
        raise HTTPException(status_code=404, detail="One or more selected statements could not be found.")

    invalid_statuses = [
        run for run in runs if str(run.get("status") or "") not in {"completed", "review"}
    ]
    if invalid_statuses:
        raise HTTPException(status_code=422, detail="Only completed or review-ready statements can be combined.")

    keys = {
        (
            str(run.get("company_name") or "").strip().lower(),
            str(run.get("bank") or "").strip().lower(),
            str(run.get("account_number") or "").strip().lower(),
        )
        for run in runs
    }
    if len(keys) > 1 and not payload.combine_different_accounts:
        raise HTTPException(status_code=422, detail="Selected statements are not the same company, bank and account number.")
    return runs


def build_combined_workbook(runs: list[dict[str, Any]], transactions_by_run: dict[str, list[ParsedTransaction]]) -> tuple[bytes, dict[str, Any]]:
    generation_started = time.perf_counter()
    sorted_runs = sorted(runs, key=lambda run: str(run.get("statement_period_start") or run.get("created_at") or ""))
    first_run = sorted_runs[0]
    last_run = sorted_runs[-1]
    company_name = first_run.get("company_name") or "Unknown company"
    bank = first_run.get("bank") or "FNB South Africa"
    account_number = first_run.get("account_number") or ""
    opening_known = first_run.get("opening_balance") is not None
    closing_known = last_run.get("closing_balance") is not None
    opening = decimal_amount(first_run.get("opening_balance")) if opening_known else None
    closing = decimal_amount(last_run.get("closing_balance")) if closing_known else None

    continuity: list[dict[str, Any]] = []
    for previous, current in zip(sorted_runs, sorted_runs[1:]):
        previous_close = previous.get("closing_balance")
        current_open = current.get("opening_balance")
        state, diff = continuity_state(previous_close, current_open)
        continuity.append({
            "previous_period": run_period_label(previous),
            "next_period": run_period_label(current),
            "previous_closing": decimal_amount(previous_close) if previous_close is not None else None,
            "next_opening": decimal_amount(current_open) if current_open is not None else None,
            "status": state,
            "difference": diff,
        })

    combined_transactions: list[tuple[ParsedTransaction, dict[str, Any], int]] = []
    seen: dict[tuple[str, str, str, str, str, str, str, str, str], float] = {}
    duplicates_removed = 0
    for run_index, run in enumerate(sorted_runs):
        for row_index, transaction in enumerate(transactions_by_run.get(str(run["id"]), []), start=1):
            key = combine_fingerprint(run, transaction, row_index)
            previous_confidence = seen.get(key)
            current_confidence = float(transaction.confidence or 0)
            if previous_confidence is not None and previous_confidence >= 98 and current_confidence >= 98:
                duplicates_removed += 1
                log_event(
                    "worker.combine_duplicate_removed",
                    run_id=run.get("id"),
                    transaction_date=transaction.transaction_date,
                    description=transaction.description,
                    confidence=current_confidence,
                )
                continue
            seen[key] = max(previous_confidence or 0, current_confidence)
            combined_transactions.append((transaction, run, run_index))

    combined_transactions.sort(
        key=lambda item: (
            parse_iso_date_or_max(item[0].transaction_date),
            extract_transaction_time(item[0].raw_text),
            item[2],
            item[0].source_page if item[0].source_page is not None else 10**9,
            item[0].source_row if item[0].source_row is not None else 10**9,
        )
    )

    rows: list[dict[str, Any]] = []
    for transaction, run, _run_index in combined_transactions:
        row = professional_transaction_row(transaction, "combined")
        row["source_period"] = run_period_label(run)
        rows.append(row)

    ai_started = time.perf_counter()
    ai_stats = apply_ai_classifications(rows)
    ai_duration_ms = round((time.perf_counter() - ai_started) * 1000, 2)
    ai_stats["ai_classification_duration_ms"] = ai_duration_ms
    mark_possible_duplicates(rows)

    reportable_rows = [row for row in rows if reporting_account(row) != "Review Required Suspense"]
    total_debits = sum((row["money_out"] for row in rows), Decimal("0.00")).quantize(CENT)
    total_credits = sum((row["money_in"] for row in rows), Decimal("0.00")).quantize(CENT)
    expected_closing = (opening + total_credits - total_debits).quantize(CENT) if opening is not None else None
    difference = (expected_closing - closing).quantize(CENT) if expected_closing is not None and closing is not None else None
    review_count = sum(1 for row in rows if row.get("review_required") or reporting_account(row) == "Review Required Suspense")
    continuity_passed = all(item["status"] == "PASSED" for item in continuity)
    continuity_failed = any(item["status"] == "FAILED" for item in continuity)
    continuity_unknown = any(item["status"] == "UNKNOWN" for item in continuity)
    continuity_result = "PASSED" if continuity_passed else "FAILED" if continuity_failed else "UNKNOWN"

    workbook = Workbook()
    dashboard = workbook.active
    dashboard.title = "Dashboard"
    dashboard.merge_cells("A1:H1")
    dashboard["A1"] = f"{company_name} - Combined Bank Statement Accounting Pack"
    dashboard["A1"].font = Font(bold=True, size=14, color="FFFFFF")
    dashboard["A1"].fill = HEADER_FILL
    dashboard["A1"].alignment = Alignment(horizontal="center")
    dashboard.merge_cells("A2:H2")
    dashboard["A2"] = ACCOUNTING_REPORT_DISCLAIMER
    dashboard["A2"].font = Font(italic=True, size=9, color="475569")
    dashboard["A2"].alignment = Alignment(wrap_text=True)
    dashboard_rows = [
        ("Company name", company_name),
        ("Bank", bank),
        ("Account number", account_number),
        ("Combined period", f"{first_run.get('statement_period_start') or '-'} to {last_run.get('statement_period_end') or '-'}"),
        ("Number of statements", len(sorted_runs)),
        ("Opening balance", opening if opening is not None else "Unknown"),
        ("Closing balance", closing if closing is not None else "Unknown"),
        ("Total receipts", total_credits),
        ("Total payments", total_debits),
        ("Total transactions", len(rows)),
        ("Review items", review_count),
        ("Workbook status", "Combined workbook generated with review items." if review_count else "Combined workbook generated."),
    ]
    for index, row in enumerate(dashboard_rows, start=3):
        write_row(dashboard, list(row), index)
    write_row_at(dashboard, ["Month", "VAT-classified receipts", "VAT-classified payments", "Output VAT", "Input VAT", "VAT Payable/(Refund)"], 3, 4, header=True)
    for row_index, month_row in enumerate(month_summary(reportable_rows), start=4):
        write_row_at(
            dashboard,
            [month_row["month"], month_row["receipts"], month_row["payments"], month_row["output_vat"], month_row["input_vat"], month_row["vat_payable"]],
            row_index,
            4,
        )

    tx = workbook.create_sheet("Transactions")
    tx_headers = [
        "Date", "Month", "Source Period", "Description", "Money In", "Money Out", "Amount", "Type", "Balance", "Bank Charge",
        "Account", "Group", "VAT Treatment", "VAT Claim Status", "Potential Output VAT", "Potential Input VAT",
    ]
    write_row(tx, tx_headers, 1, header=True)
    for row_index, row in enumerate(rows, start=2):
        write_row(
            tx,
            [
                row["date"], row["month"], row["source_period"], row["description"], row["money_in"], row["money_out"], row["amount"], row["type"],
                row["balance"], row["bank_charge"], reporting_account(row), row["group"], row["vat_treatment"], reporting_vat_status(row),
                row["potential_output_vat"] if reporting_account(row) != "Review Required Suspense" else Decimal("0.00"),
                row["potential_input_vat"] if reporting_account(row) != "Review Required Suspense" else Decimal("0.00"),
            ],
            row_index,
        )
    apply_number_formats(tx, [5, 6, 7, 9, 10, 15, 16])

    vat, vat_detail_header_row, vat_column_count = write_vat_schedule_sheet(workbook, rows, include_source_period=True)

    ledger = workbook.create_sheet("General Ledger")
    write_row(ledger, ["Date", "Description", "Account", "Debit", "Credit", "Source Period"], 1, header=True)
    gl_row = 2
    write_row(ledger, [workbook_date(first_run.get("statement_period_start")), "Opening balance first statement", "Bank", opening, Decimal("0.00"), run_period_label(first_run)], gl_row)
    gl_row += 1
    write_row(ledger, [workbook_date(first_run.get("statement_period_start")), "Opening balance first statement", "Opening Equity / Prior Periods", Decimal("0.00"), opening, run_period_label(first_run)], gl_row)
    gl_row += 1
    for row in rows:
        if row["money_out"] > 0:
            write_row(ledger, [row["date"], row["description"], reporting_account(row), row["money_out"], Decimal("0.00"), row["source_period"]], gl_row)
            gl_row += 1
            write_row(ledger, [row["date"], row["description"], "Bank", Decimal("0.00"), row["money_out"], row["source_period"]], gl_row)
            gl_row += 1
        elif row["money_in"] > 0:
            write_row(ledger, [row["date"], row["description"], "Bank", row["money_in"], Decimal("0.00"), row["source_period"]], gl_row)
            gl_row += 1
            write_row(ledger, [row["date"], row["description"], reporting_account(row), Decimal("0.00"), row["money_in"], row["source_period"]], gl_row)
            gl_row += 1
    apply_number_formats(ledger, [4, 5])

    trial = workbook.create_sheet("Trial Balance")
    write_row(trial, ["Account", "Total Debits", "Total Credits", "Debit Balance", "Credit Balance"], 1, header=True)
    ledger_accounts = sorted({ledger.cell(row=row, column=3).value for row in range(2, ledger.max_row + 1) if ledger.cell(row=row, column=3).value})
    for row_index, account in enumerate(ledger_accounts, start=2):
        debits = sum(decimal_amount(ledger.cell(row=row, column=4).value) for row in range(2, ledger.max_row + 1) if ledger.cell(row=row, column=3).value == account)
        credits = sum(decimal_amount(ledger.cell(row=row, column=5).value) for row in range(2, ledger.max_row + 1) if ledger.cell(row=row, column=3).value == account)
        net = (debits - credits).quantize(CENT)
        write_row(trial, [account, debits, credits, net if net > 0 else Decimal("0.00"), abs(net) if net < 0 else Decimal("0.00")], row_index)
    apply_number_formats(trial, [2, 3, 4, 5])

    rec = workbook.create_sheet("Bank Rec")
    rec_rows = [
        ("Opening balance first period", opening if opening is not None else "Unknown"),
        ("Total credits all periods", total_credits),
        ("Total debits all periods", total_debits),
        ("Expected closing balance", expected_closing if expected_closing is not None else "Unknown"),
        ("Actual closing balance last period", closing if closing is not None else "Unknown"),
        ("Difference", difference if difference is not None else "Unknown"),
        ("Status", "Reconciled" if difference == 0 and continuity_result == "PASSED" else "Review required"),
        ("Period continuity check", continuity_result),
    ]
    write_row(rec, ["Combined Bank Reconciliation", "Amount"], 1, header=True)
    for row_index, row in enumerate(rec_rows, start=2):
        write_row(rec, list(row), row_index)
    write_row(rec, ["Previous Period", "Next Period", "Previous Closing", "Next Opening", "Difference", "Status"], 12, header=True)
    for row_index, item in enumerate(continuity, start=13):
        write_row(rec, [item["previous_period"], item["next_period"], item["previous_closing"], item["next_opening"], item["difference"], item["status"]], row_index)
    apply_number_formats(rec, [2, 3, 4, 5])

    review = workbook.create_sheet("Review Items")
    write_row(review, ["Date", "Source Period", "Description", "Money In", "Money Out", "Account", "VAT Status", "Reason"], 1, header=True)
    review_row = 2
    for row in rows:
        reason = row.get("review_reason") or professional_review_reason(row)
        if row.get("review_required") or reporting_account(row) == "Review Required Suspense":
            write_row(review, [row["date"], row["source_period"], row["description"], row["money_in"], row["money_out"], reporting_account(row), reporting_vat_status(row), reason or "Review recommended"], review_row)
            review_row += 1
    apply_number_formats(review, [4, 5])

    assumptions = workbook.create_sheet("Assumptions")
    assumptions_rows = [
        ("Area", "Assumption / Note"),
        ("Report limitation", ACCOUNTING_REPORT_DISCLAIMER),
        ("Batch processing", "Statements are sorted by statement period start date before combining."),
        ("Duplicate removal", "Potential duplicates are removed by matching date, merchant pattern, amount and running balance."),
        ("Account rule", "Default batch generation only combines the same company, bank and account number."),
        ("Review mode", "Statements with review items can be combined, but unresolved transactions stay in Review Required Suspense."),
        ("Continuity", "Previous closing balance should equal the next opening balance."),
    ]
    for row_index, row in enumerate(assumptions_rows, start=1):
        write_row(assumptions, list(row), row_index, header=row_index == 1)

    diagnostics = workbook.create_sheet("Diagnostics")
    write_row(diagnostics, ["Metric", "Value"], 1, header=True)
    diagnostics_rows = [
        ("worker", worker_version()),
        ("run_ids", [run.get("id") for run in sorted_runs]),
        ("duplicates_removed", duplicates_removed),
        ("continuity", continuity),
        ("ai", ai_stats),
    ]
    for row_index, row in enumerate(diagnostics_rows, start=2):
        write_row(diagnostics, [row[0], json.dumps(row[1], default=str)], row_index)
    diagnostics.sheet_state = "hidden"

    metadata_sheet = workbook.create_sheet("Metadata")
    generated_at = datetime.utcnow().isoformat()
    combined_start = first_run.get("statement_period_start") or "Unknown"
    combined_end = last_run.get("statement_period_end") or "Unknown"
    metadata_rows = [
        ("Parser Version", WORKER_PARSER_VERSION),
        ("Worker Version", worker_version()),
        ("Generated Date", generated_at),
        ("Company", company_name),
        ("Bank", bank),
        ("Account Number", account_number),
        ("Combined Months", f"{combined_start} to {combined_end}"),
        ("Statement Count", len(sorted_runs)),
        ("Duplicate Rows Removed", duplicates_removed),
        ("Continuity Result", continuity_result),
        ("Review Status", "Review Required" if review_count or continuity_result != "PASSED" else "Completed"),
        ("Generation Time", "pending"),
    ]
    write_row(metadata_sheet, ["Metric", "Value"], 1, header=True)
    for row_index, row in enumerate(metadata_rows, start=2):
        write_row(metadata_sheet, [row[0], json.dumps(row[1], default=str) if isinstance(row[1], (dict, list)) else row[1]], row_index)
    metadata_sheet.sheet_state = "hidden"

    finish_sheet(dashboard, freeze_pane="D4")
    finish_sheet(tx, filter_ref=f"A1:P{max(tx.max_row, 1)}")
    finish_sheet(vat, freeze_pane=f"A{vat_detail_header_row + 1}", filter_ref=f"A{vat_detail_header_row}:{get_column_letter(vat_column_count)}{max(vat.max_row, vat_detail_header_row)}")
    finish_sheet(ledger, filter_ref=f"A1:F{max(ledger.max_row, 1)}")
    finish_sheet(trial, filter_ref=f"A1:E{max(trial.max_row, 1)}")
    finish_sheet(rec)
    finish_sheet(review, filter_ref=f"A1:H{max(review.max_row, 1)}")
    finish_sheet(assumptions)
    finish_sheet(diagnostics)
    finish_sheet(metadata_sheet)

    generation_duration_ms = round((time.perf_counter() - generation_started) * 1000, 2)
    metadata_sheet.cell(row=13, column=2).value = f"{generation_duration_ms} ms"
    output = io.BytesIO()
    validate_workbook_for_export(workbook)
    workbook.save(output)
    continuity_message = continuity_failure_message(continuity)
    if continuity_message:
        log_warning("worker.combine_continuity_review", continuity=continuity, message=continuity_message)
    log_event(
        "worker.combine_summary",
        parser_profile=WORKER_PARSER_VERSION,
        continuity_result=continuity_result,
        continuity=continuity,
        duplicates_removed=duplicates_removed,
        workbook_generation_duration_ms=generation_duration_ms,
    )
    return output.getvalue(), {
        "statement_count": len(sorted_runs),
        "transaction_count": len(rows),
        "duplicates_removed": duplicates_removed,
        "review_count": review_count,
        "continuity_ok": continuity_result == "PASSED",
        "continuity_result": continuity_result,
        "continuity": continuity,
        "difference": str(difference) if difference is not None else "Unknown",
        "continuity_message": continuity_message,
        "workbook_generation_duration_ms": generation_duration_ms,
    }


@app.get("/health")
def health() -> dict[str, str]:
    return worker_version()


@app.get("/version")
def version() -> dict[str, str]:
    return worker_version()


@app.post("/combine-fnb-statements")
def combine_fnb_statements(payload: CombineRequest, authorization: str | None = Header(default=None)) -> Response:
    verify_worker_token(authorization)
    validation_started = time.perf_counter()
    if len(payload.run_ids) < 2:
        raise HTTPException(status_code=400, detail="Select at least two statements to combine.")

    supabase = get_supabase()
    log_event("worker.combine_request", workspace_id=payload.workspace_id, run_ids=payload.run_ids)

    try:
      runs_response = (
          supabase.table("accounting_statement_runs")
          .select("*")
          .eq("workspace_id", payload.workspace_id)
          .in_("id", payload.run_ids)
          .execute()
      )
      runs = runs_response.data if isinstance(runs_response.data, list) else []
      runs = validate_combine_runs(runs, payload)
      validation_duration_ms = round((time.perf_counter() - validation_started) * 1000, 2)
      log_event("worker.combine_validated", validation_duration_ms=validation_duration_ms, parser_profile=WORKER_PARSER_VERSION)

      continuity, continuity_result, continuity_message = run_continuity_summary(runs)
      log_event("worker.combine_continuity_checked", continuity_result=continuity_result, continuity=continuity)
      if continuity_result != "PASSED" and not payload.override_continuity:
          message = continuity_message or "Continuity checks failed. Review required before combining."
          supabase.table("accounting_statement_runs").update(
              {
                  "status": "review",
                  "error": message,
                  "updated_at": datetime.utcnow().isoformat(),
              }
          ).eq("workspace_id", payload.workspace_id).in_("id", payload.run_ids).execute()
          raise HTTPException(
              status_code=422,
              detail={
                  "status": "review_required",
                  "message": message,
                  "continuity": continuity,
                  "allow_override": True,
              },
          )

      transactions_by_run: dict[str, list[ParsedTransaction]] = {}
      for run in runs:
          transaction_response = (
              supabase.table("accounting_transactions")
              .select("*")
              .eq("workspace_id", payload.workspace_id)
              .eq("run_id", run["id"])
              .execute()
          )
          transaction_rows = transaction_response.data if isinstance(transaction_response.data, list) else []
          transactions_by_run[str(run["id"])] = [parsed_transaction_from_row(row) for row in transaction_rows]

      export_started = time.perf_counter()
      workbook_bytes, summary = build_combined_workbook(runs, transactions_by_run)

      export_duration_ms = round((time.perf_counter() - export_started) * 1000, 2)
      summary["export_duration_ms"] = export_duration_ms
      log_event("worker.combine_completed", workspace_id=payload.workspace_id, summary=summary)
      return Response(
          content=workbook_bytes,
          media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          headers={"X-DocuCoreX-Combined-Summary": json.dumps(summary, default=str)},
      )
    except HTTPException:
      raise
    except Exception as exc:
      log_exception("worker.combine_failed", workspace_id=payload.workspace_id, run_ids=payload.run_ids, error=str(exc))
      raise HTTPException(status_code=422, detail=str(exc))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    body = await request.body()
    missing_fields = [
        ".".join(str(part) for part in error.get("loc", []))
        for error in exc.errors()
        if error.get("type") == "missing"
    ]
    log_warning(
        "worker.validation_error",
        path=str(request.url.path),
        missing_fields=missing_fields,
        errors=exc.errors(),
        body=body.decode("utf-8", errors="replace"),
    )
    return JSONResponse(
        status_code=422,
        content={
            "detail": exc.errors(),
            "missing_fields": missing_fields,
            "message": "Worker request validation failed.",
            "worker": worker_version(),
        },
    )


@app.post("/process-fnb-statement")
def process_fnb_statement(payload: ProcessRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_worker_token(authorization)
    supabase = get_supabase()
    bucket = os.getenv("SUPABASE_BUCKET", "documents")
    process_started = time.perf_counter()
    parser_profile = WORKER_PARSER_VERSION
    parser_version = WORKER_PARSER_VERSION
    bank_name = "FNB South Africa"

    log_event(
        "worker.process_request",
        worker=worker_version(),
        run_id=payload.run_id,
        workspace_id=payload.workspace_id,
        document_id=payload.document_id,
        processing_job_id=payload.processing_job_id,
        storage_path=payload.storage_path,
        bucket=bucket,
    )

    try:
        heartbeat_step(
            supabase,
            run_id=payload.run_id,
            workspace_id=payload.workspace_id,
            processing_job_id=payload.processing_job_id,
            step_label="Detecting PDF type",
            progress=20,
        )
        pdf_bytes = supabase.storage.from_(bucket).download(payload.storage_path)
        log_event("worker.storage_downloaded", run_id=payload.run_id, bytes=len(pdf_bytes or b""))
        heartbeat_step(
            supabase,
            run_id=payload.run_id,
            workspace_id=payload.workspace_id,
            processing_job_id=payload.processing_job_id,
            step_label="Running OCR",
            progress=45,
        )
        pages = extract_statement_text(pdf_bytes) or []
        native_text = "\n".join((page.get("text") or "") for page in pages)
        # Prefer the Node pipeline's best extraction when it is meaningfully long;
        # the natively-extracted PDF text remains the fallback.
        provided = (payload.pre_extracted_text or "").strip()
        log_event(
            "worker.pre_extracted_text_received",
            run_id=payload.run_id,
            received=bool(provided),
            length=len(provided),
            sample=provided[:1000],
            parser_method=payload.parser_method,
            extraction_source=payload.extraction_source,
            ocr_used=bool(payload.ocr_used),
        )
        if provided and len(provided) >= max(200, len(native_text) // 2):
            full_text = provided
            log_event(
                "worker.pre_extracted_text_used",
                run_id=payload.run_id,
                provided_chars=len(provided),
                native_chars=len(native_text),
            )
        else:
            full_text = native_text
            if provided:
                log_event(
                    "worker.pre_extracted_text_rejected",
                    run_id=payload.run_id,
                    provided_chars=len(provided),
                    native_chars=len(native_text),
                    reason="provided text shorter than half the native text",
                )
        parser = BankRegistry.detect(full_text[:4000], payload.storage_path)
        if parser is None:
            raise HTTPException(status_code=422, detail="No parser profile is registered for this statement.")
        parser_profile = parser.profile.id
        parser_version = parser.profile.version
        bank_name = parser.profile.bank_name
        if parser_profile != "fnb_business_v1":
            raise HTTPException(
                status_code=422,
                detail=with_worker_version(
                    {
                        "message": f"Detected parser profile {parser_profile}, but only fnb_business_v1 is implemented for extraction in this phase.",
                        "status": "parser_profile_not_implemented",
                    }
                ),
            )
        log_event(
            "worker.text_extracted",
            run_id=payload.run_id,
            pages=len(pages),
            characters=len(full_text),
            parser_profile=parser_profile,
        )
        metadata = parse_metadata(full_text)
        metadata["parser_profile"] = parser_profile
        metadata["parser_version"] = parser_version
        metadata["source_file"] = os.path.basename(payload.storage_path).split(".pdf")[0][:80] or "28 Feb 2026 - (Free)"
        candidates = transaction_candidate_lines(full_text)
        service_fee_candidates = service_fee_candidate_lines(full_text)
        log_event(
            "worker.transaction_candidates_built",
            worker=worker_version(),
            run_id=payload.run_id,
            candidates=len(candidates),
            service_fee_candidates=len(service_fee_candidates),
            service_fee_candidate_samples=service_fee_candidates[:6],
            parser_version=parser_version,
        )
        heartbeat_step(
            supabase,
            run_id=payload.run_id,
            workspace_id=payload.workspace_id,
            processing_job_id=payload.processing_job_id,
            step_label="Parsing transactions",
            progress=70,
        )
        transactions = parse_transactions(pages, metadata, full_text) or []
        classification_rules = fetch_classification_rules(supabase, payload.workspace_id) or []
        learned_rules_applied = apply_learned_classification_rules(transactions, classification_rules)
        # Accounting-parser diagnostics (null-safe).
        _summary = validation_summary(transactions)
        log_event(
            "worker.accounting_parser",
            run_id=payload.run_id,
            opening_balance_found=metadata.get("opening_balance") is not None,
            closing_balance_found=metadata.get("closing_balance") is not None,
            transactions_parsed=len(transactions),
            credit_count=_summary.get("credit_count"),
            debit_count=_summary.get("debit_count"),
            parser_method=payload.parser_method,
        )
        log_event(
            "worker.statement_parsed",
            worker=worker_version(),
            run_id=payload.run_id,
            metadata_fields=sorted([key for key, value in metadata.items() if value is not None]),
            transactions=len(transactions),
            parser_version=parser_version,
            service_fee_rows=sum(1 for transaction in transactions if transaction.description.startswith("#")),
            learned_rules_applied=learned_rules_applied,
        )

        if not transactions:
            diagnostics = extraction_diagnostics(pages, full_text, metadata)
            pipeline_debug = payload.extraction_debug if isinstance(payload.extraction_debug, dict) else {}
            # Parser debug — surface the REAL reason, never hide it.
            parser_debug = {
                "selected_parser": pipeline_debug.get("selectedParser") or payload.parser_method,
                "detected_pdf_type": pipeline_debug.get("detectedPdfType"),
                "ocr_used": pipeline_debug.get("ocrUsed") if pipeline_debug.get("ocrUsed") is not None else bool(payload.ocr_used),
                "pdfjs_text_length": pipeline_debug.get("pdfjsTextLength"),
                "ocr_text_length": pipeline_debug.get("ocrTextLength"),
                "pre_extracted_text_length": pipeline_debug.get("preExtractedTextLength", len((payload.pre_extracted_text or "").strip())),
                "sample_text": (full_text or "")[:1000],
                "reason_no_transactions": pipeline_debug.get("reasonNoTransactions"),
            }
            reason = parser_debug["reason_no_transactions"] or "No FNB transactions could be parsed from this PDF."
            log_warning("worker.no_transactions_parsed", run_id=payload.run_id, diagnostics=diagnostics, parser_debug=parser_debug)
            raise HTTPException(
                status_code=422,
                detail={
                    "message": reason,
                    "diagnostics": diagnostics,
                    "parser_debug": parser_debug,
                    "worker": worker_version(),
                },
            )

        validation: dict[str, Any] | None = None
        review_issue: dict[str, Any] | None = None
        heartbeat_step(
            supabase,
            run_id=payload.run_id,
            workspace_id=payload.workspace_id,
            processing_job_id=payload.processing_job_id,
            step_label="Reconciling",
            progress=90,
        )
        try:
            validation_started = time.perf_counter()
            validation = validate_statement(metadata, transactions)
            validation_duration_ms = round((time.perf_counter() - validation_started) * 1000, 2)
            log_event(
                "worker.statement_validated",
                run_id=payload.run_id,
                validation={key: str(value) for key, value in validation.items()},
                validation_duration_ms=validation_duration_ms,
            )
        except HTTPException as exc:
            review_issue = review_validation_issue(exc)
            if not review_issue:
                raise
            log_warning(
                "worker.statement_needs_review",
                run_id=payload.run_id,
                errors=review_issue["errors"],
                summary=review_issue["summary"],
                balance_gaps=review_issue["balance_gaps"][:10],
                parser_version=parser_version,
            )
            for transaction in transactions:
                if transaction.review_status == "ready":
                    transaction.review_status = "needs_review"

        run_state = (
            supabase.table("accounting_statement_runs")
            .select("status")
            .eq("id", payload.run_id)
            .eq("workspace_id", payload.workspace_id)
            .maybe_single()
            .execute()
        )
        if (run_state.data or {}).get("status") == "cancelled":
            log_warning("worker.run_cancelled_before_write", run_id=payload.run_id)
            return {
                "status": "cancelled",
                "transactions": 0,
                "workbook_storage_path": None,
                "confidence": 0,
                "validation": None,
                "review_issue": None,
                "ai_diagnostics": ai_diagnostics(enabled=False),
                "parser_profile": parser_profile,
                "processing_duration_ms": round((time.perf_counter() - process_started) * 1000, 2),
                "worker": worker_version(),
            }

        supabase.table("accounting_transactions").delete().eq("run_id", payload.run_id).execute()
        rows = [transaction_insert_row(transaction, payload.run_id, payload.workspace_id) for transaction in transactions]
        supabase.table("accounting_transactions").insert(rows).execute()

        # General extraction validation (count / totals / reconciliation vs the
        # statement's own declared figures). Bank charges come from the declared
        # fee summary, not from cash-deposit amounts.
        extraction_check = validate_extraction(metadata, transactions)
        extraction_incomplete = extraction_check["status"] != "ok"
        heartbeat_step(
            supabase,
            run_id=payload.run_id,
            workspace_id=payload.workspace_id,
            processing_job_id=payload.processing_job_id,
            step_label="Generating workbook",
            progress=97,
        )
        workbook_bytes = build_workbook(
            metadata,
            transactions,
            allow_ai=not extraction_incomplete and review_issue is None,
        )
        ai_stats = metadata.get("_ai_diagnostics") or ai_diagnostics(enabled=False)
        workbook_path = f"{payload.workspace_id}/accounting/fnb/exports/{payload.run_id}.xlsx"
        export_started = time.perf_counter()
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as handle:
            handle.write(workbook_bytes)
            handle.flush()
            supabase.storage.from_(bucket).upload(
                workbook_path,
                handle.name,
                file_options={
                    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "upsert": "true",
                },
            )
        export_duration_ms = round((time.perf_counter() - export_started) * 1000, 2)
        log_event("worker.workbook_exported", run_id=payload.run_id, duration_ms=export_duration_ms, parser_profile=WORKER_PARSER_VERSION)

        bank_charges_total = float(bank_charges_from_statement(metadata, transactions))
        avg_confidence = sum(transaction.confidence for transaction in transactions) / len(transactions)
        status = "review" if (
            review_issue
            or extraction_incomplete
            or any(transaction.review_status == "needs_review" for transaction in transactions)
        ) else "completed"
        if review_issue:
            run_error = review_error_message(review_issue)
        elif extraction_incomplete:
            expected_count = extraction_check.get("expected_transaction_count")
            extracted_count = extraction_check.get("extracted_transaction_count")
            recon_diff = extraction_check.get("reconciliation_difference")
            run_error = (
                "Extraction incomplete — "
                f"extracted {extracted_count} of {expected_count} transactions; "
                f"reconciliation difference {recon_diff}; "
                f"failed checks: {', '.join(extraction_check.get('failures') or [])}."
            )
        else:
            run_error = None
        processing_duration_ms = round((time.perf_counter() - process_started) * 1000, 2)
        review_required = status == "review"
        validation = {**(validation or {}), **{f"extraction_{k}": v for k, v in extraction_check.items() if k != "checks"}}

        update_statement_run(
            supabase,
            payload.run_id,
            payload.workspace_id,
            {
                **statement_run_metadata(metadata),
                "status": status,
                "bank": bank_name,
                "transaction_count": len(transactions),
                "bank_charges_total": bank_charges_total,
                "workbook_storage_path": workbook_path,
                "parser_profile": parser_profile,
                "parser_version": parser_version,
                "review_required": review_required,
                "review_reason": run_error,
                "validation_status": extraction_check.get("status"),
                "reconciliation_difference": extraction_check.get("reconciliation_difference"),
                "missing_transaction_count": missing_transaction_count_for_storage(extraction_check, len(transactions)),
                "requires_review": review_required,
                "processing_duration_ms": int(processing_duration_ms),
                "extraction_accuracy": round(avg_confidence, 2),
                "confidence": round(avg_confidence, 2),
                "error": run_error,
                "updated_at": datetime.utcnow().isoformat(),
            },
        )

        refresh_statement_analytics(supabase, payload.workspace_id, bank_name, parser_profile, parser_version)

        if payload.processing_job_id:
            supabase.table("processing_jobs").update(
                {
                    "status": "completed",
                    "progress": 100,
                    "message": "Accounting workbook ready for review" if review_issue else "Accounting workbook ready",
                    "error": run_error,
                    "updated_at": datetime.utcnow().isoformat(),
                }
            ).eq("id", payload.processing_job_id).execute()

        log_event(
            "worker.process_completed",
            run_id=payload.run_id,
            status=status,
            transactions=len(transactions),
            workbook_storage_path=workbook_path,
            confidence=round(avg_confidence, 2),
            validation={key: str(value) for key, value in validation.items()} if validation else None,
            review_issue=review_issue,
            ai_diagnostics=ai_stats,
            export_duration_ms=export_duration_ms,
            parser_profile=parser_profile,
            processing_duration_ms=processing_duration_ms,
        )

        return {
            "status": status,
            "transactions": len(transactions),
            "workbook_storage_path": workbook_path,
            "confidence": round(avg_confidence, 2),
            "validation": {key: str(value) for key, value in validation.items()} if validation else None,
            "review_issue": review_issue,
            "ai_diagnostics": ai_stats,
            "parser_profile": parser_profile,
            "processing_duration_ms": processing_duration_ms,
            "worker": worker_version(),
        }
    except HTTPException as exc:
        message = json.dumps(exc.detail, default=str) if isinstance(exc.detail, (dict, list)) else str(exc.detail)
        record_parser_failure(supabase, payload.workspace_id, bank_name, message)
        log_exception(
            "worker.process_failed",
            run_id=payload.run_id,
            workspace_id=payload.workspace_id,
            document_id=payload.document_id,
            processing_job_id=payload.processing_job_id,
            storage_path=payload.storage_path,
            error=message,
        )
        supabase.table("accounting_statement_runs").update(
            {"status": "failed", "error": message, "updated_at": datetime.utcnow().isoformat()}
        ).eq("id", payload.run_id).eq("workspace_id", payload.workspace_id).execute()
        if payload.processing_job_id:
            supabase.table("processing_jobs").update(
                {"status": "failed", "progress": 100, "message": message, "error": message, "updated_at": datetime.utcnow().isoformat()}
            ).eq("id", payload.processing_job_id).execute()
        raise exc
    except Exception as exc:
        message = str(exc)
        record_parser_failure(supabase, payload.workspace_id, bank_name, message)
        log_exception(
            "worker.process_failed",
            run_id=payload.run_id,
            workspace_id=payload.workspace_id,
            document_id=payload.document_id,
            processing_job_id=payload.processing_job_id,
            storage_path=payload.storage_path,
            error=message,
        )
        supabase.table("accounting_statement_runs").update(
            {"status": "failed", "error": message, "updated_at": datetime.utcnow().isoformat()}
        ).eq("id", payload.run_id).eq("workspace_id", payload.workspace_id).execute()
        if payload.processing_job_id:
            supabase.table("processing_jobs").update(
                {"status": "failed", "progress": 100, "message": message, "error": message, "updated_at": datetime.utcnow().isoformat()}
            ).eq("id", payload.processing_job_id).execute()
        raise HTTPException(status_code=422, detail=with_worker_version({"message": message})) from exc


@app.post("/process-statement")
def process_statement(payload: ProcessRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return process_fnb_statement(payload, authorization)
