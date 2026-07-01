import io
import json
import logging
import os
import re
import tempfile
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import fitz
import pdfplumber
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from pydantic import BaseModel
from supabase import Client, create_client


app = FastAPI(title="DocuCoreX Accounting Worker")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("docucorex.accounting_worker")
MONEY_TOKEN = re.compile(
    r"(?<!\d)(?P<negative>-)?(?:R\s*)?(?P<bracket>\()?(?P<amount>(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?:\))?\s*(?P<suffix>Cr|CR|Dr|DR)?(?!\d)",
    re.IGNORECASE,
)
MAX_DATABASE_AMOUNT = Decimal("999999999999.99")
CENT = Decimal("0.01")


def log_event(event: str, **fields: Any) -> None:
    logger.info(json.dumps({"event": event, **fields}, default=str))


def log_warning(event: str, **fields: Any) -> None:
    logger.warning(json.dumps({"event": event, **fields}, default=str))


def log_exception(event: str, **fields: Any) -> None:
    logger.exception(json.dumps({"event": event, **fields}, default=str))


class ProcessRequest(BaseModel):
    run_id: str
    workspace_id: str
    document_id: str | None = None
    processing_job_id: str | None = None
    storage_path: str


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
    raw_text: str | None = None


def get_supabase() -> Client:
    url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return create_client(url, key)


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
        suffix_match = re.search(r"\b(Cr|CR|Dr|DR)\b\s*$", value.strip())
        suffix = suffix_match.group(1).lower() if suffix_match else ""
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


def parse_metadata(full_text: str) -> dict[str, Any]:
    account_number = find_first([
        r"Account\s*(?:Number|No\.?)\s*[:\-]?\s*([0-9\s-]{6,})",
        r"Business\s*Account\s*[:\-]?\s*([0-9\s-]{6,})",
    ], full_text)

    company_name = find_first([
        r"Account\s*Holder\s*[:\-]?\s*(.+)",
        r"Customer\s*Name\s*[:\-]?\s*(.+)",
        r"^([A-Z0-9 &().,'/-]{5,})\n(?:Account|Statement)",
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

    return {
        "company_name": company_name,
        "account_number": re.sub(r"\s+", "", account_number) if account_number else None,
        "statement_period_start": parse_date(period.group(1)) if period else None,
        "statement_period_end": parse_date(period.group(2)) if period else None,
        "opening_balance": parse_money(opening_balance),
        "closing_balance": parse_money(closing_balance),
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
    rules = [
        (("bank charges", "service fee", "monthly fee", "cash deposit fee"), "Bank Charges", "out_of_scope", True, 96),
        (("vat", "value added tax"), "VAT Control", "standard", False, 92),
        (("salary", "payroll", "wages"), "Payroll", "out_of_scope", False, 88),
        (("rent", "lease"), "Rent", "standard", False, 84),
        (("fuel", "petrol", "garage", "engen", "shell", "bp "), "Motor Vehicle Expenses", "standard", False, 82),
        (("loan", "interest"), "Finance Costs", "exempt", False, 80),
        (("transfer", "trf", "internal"), "Transfers", "out_of_scope", False, 78),
        (("subscription", "saas", "microsoft", "google", "adobe"), "Software Subscriptions", "standard", False, 80),
    ]
    for needles, category, vat, bank_charge, confidence in rules:
        if any(needle in text for needle in needles):
            return category, vat, bank_charge, confidence
    if credit and credit > 0:
        return "Income", "review", False, 72
    if debit and debit > 0:
        return "Operating Expenses", "review", False, 68
    return "Uncategorised", "review", False, 55


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
    if not normalized_description or is_noise_transaction(normalized_description):
        return None

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
    confidence = min(99, max(base_confidence, rule_confidence))
    review_status = "ready" if confidence >= 85 else "needs_review"

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


def parse_transactions(pages: list[dict[str, Any]], metadata: dict[str, Any]) -> list[ParsedTransaction]:
    table_transactions = parse_table_transactions(pages, metadata)
    if table_transactions:
        return dedupe_transactions(table_transactions)
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


def validate_statement(metadata: dict[str, Any], transactions: list[ParsedTransaction]) -> dict[str, Any]:
    summary = validation_summary(transactions)
    opening = decimal_amount(metadata.get("opening_balance"))
    closing = decimal_amount(metadata.get("closing_balance"))
    calculated_closing = (opening + summary["total_credits"] - summary["total_debits"]).quantize(CENT)
    errors: list[str] = []

    if metadata.get("opening_balance") is not None and metadata.get("closing_balance") is not None and calculated_closing != closing:
        errors.append(
            f"Bank reconciliation failed: opening {opening} + credits {summary['total_credits']} - debits {summary['total_debits']} = {calculated_closing}, expected closing {closing}."
        )

    expected_statement = {
        "opening_balance": Decimal("111600.56"),
        "total_credits": Decimal("209375.00"),
        "total_debits": Decimal("309779.10"),
        "closing_balance": Decimal("11196.46"),
        "credit_count": 4,
        "debit_count": 58,
    }
    if opening == expected_statement["opening_balance"] and closing == expected_statement["closing_balance"]:
        if summary["total_credits"] != expected_statement["total_credits"]:
            errors.append(f"Expected total credits {expected_statement['total_credits']}, parsed {summary['total_credits']}.")
        if summary["total_debits"] != expected_statement["total_debits"]:
            errors.append(f"Expected total debits {expected_statement['total_debits']}, parsed {summary['total_debits']}.")
        if summary["credit_count"] != expected_statement["credit_count"]:
            errors.append(f"Expected {expected_statement['credit_count']} credit transactions, parsed {summary['credit_count']}.")
        if summary["debit_count"] != expected_statement["debit_count"]:
            errors.append(f"Expected {expected_statement['debit_count']} debit transactions, parsed {summary['debit_count']}.")

    result = {
        "opening_balance": opening,
        "closing_balance": closing,
        "calculated_closing": calculated_closing,
        **summary,
        "transaction_count": len(transactions),
    }
    if errors:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "FNB parser validation failed.",
                "errors": errors,
                "summary": {key: str(value) for key, value in result.items()},
            },
        )
    return result


def extraction_diagnostics(pages: list[dict[str, Any]], full_text: str) -> dict[str, Any]:
    sample_lines = []
    for line in full_text.splitlines():
        cleaned = re.sub(r"\s+", " ", line).strip()
        if cleaned and len(cleaned) > 3:
            sample_lines.append(cleaned)
        if len(sample_lines) >= 30:
            break

    sample_tables = []
    for page in pages:
        for table in page.get("tables", []) or []:
            preview_rows = []
            for row in (table or [])[:5]:
                preview_rows.append([normalize_cell(cell) for cell in row or []])
            if preview_rows:
                sample_tables.append({"page": page.get("page"), "rows": preview_rows})
            if len(sample_tables) >= 3:
                break
        if len(sample_tables) >= 3:
            break

    return {
        "pages": len(pages),
        "characters": len(full_text),
        "table_count": sum(len(page.get("tables", []) or []) for page in pages),
        "sample_lines": sample_lines,
        "sample_tables": sample_tables,
    }


def write_row(sheet, values: list[Any], row_index: int, header: bool = False) -> None:
    for column_index, value in enumerate(values, start=1):
        cell = sheet.cell(row=row_index, column=column_index, value=value)
        if header:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="0F2A5F")


def build_workbook(metadata: dict[str, Any], transactions: list[ParsedTransaction]) -> bytes:
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Summary"
    summary_rows = [
        ("Company name", metadata.get("company_name")),
        ("Account number", metadata.get("account_number")),
        ("Statement period start", metadata.get("statement_period_start")),
        ("Statement period end", metadata.get("statement_period_end")),
        ("Opening balance", metadata.get("opening_balance")),
        ("Closing balance", metadata.get("closing_balance")),
        ("Transactions", len(transactions)),
        ("Bank charges total", sum(t.debit_amount or 0 for t in transactions if t.bank_charge)),
    ]
    for index, row in enumerate(summary_rows, start=1):
        write_row(summary, list(row), index, header=index == 1)

    cashbook = workbook.create_sheet("Cashbook")
    headers = ["Date", "Description", "Debit", "Credit", "Running Balance", "Category", "VAT", "Confidence", "Review Status"]
    write_row(cashbook, headers, 1, header=True)
    for index, transaction in enumerate(transactions, start=2):
        write_row(
            cashbook,
            [
                transaction.transaction_date,
                transaction.description,
                transaction.debit_amount,
                transaction.credit_amount,
                transaction.running_balance,
                transaction.account_category,
                transaction.vat_treatment,
                transaction.confidence,
                transaction.review_status,
            ],
            index,
        )

    vat = workbook.create_sheet("VAT Schedule")
    write_row(vat, ["VAT Treatment", "Debit Total", "Credit Total", "Transaction Count"], 1, header=True)
    for row_index, treatment in enumerate(["standard", "zero_rated", "exempt", "out_of_scope", "review"], start=2):
        matching = [item for item in transactions if item.vat_treatment == treatment]
        write_row(vat, [treatment, sum(item.debit_amount or 0 for item in matching), sum(item.credit_amount or 0 for item in matching), len(matching)], row_index)

    ledger = workbook.create_sheet("General Ledger")
    write_row(ledger, ["Account Category", "Debit", "Credit", "Net"], 1, header=True)
    categories = sorted({item.account_category for item in transactions})
    for row_index, category in enumerate(categories, start=2):
        matching = [item for item in transactions if item.account_category == category]
        debit = sum(item.debit_amount or 0 for item in matching)
        credit = sum(item.credit_amount or 0 for item in matching)
        write_row(ledger, [category, debit, credit, credit - debit], row_index)

    trial = workbook.create_sheet("Trial Balance")
    write_row(trial, ["Account", "Debit Balance", "Credit Balance"], 1, header=True)
    for row_index, category in enumerate(categories, start=2):
        matching = [item for item in transactions if item.account_category == category]
        net = sum(item.credit_amount or 0 for item in matching) - sum(item.debit_amount or 0 for item in matching)
        write_row(trial, [category, abs(net) if net < 0 else 0, net if net > 0 else 0], row_index)

    rec = workbook.create_sheet("Bank Reconciliation")
    write_row(rec, ["Line", "Amount"], 1, header=True)
    write_row(rec, ["Opening balance", metadata.get("opening_balance")], 2)
    write_row(rec, ["Total debits", sum(item.debit_amount or 0 for item in transactions)], 3)
    write_row(rec, ["Total credits", sum(item.credit_amount or 0 for item in transactions)], 4)
    write_row(rec, ["Closing balance", metadata.get("closing_balance")], 5)

    review = workbook.create_sheet("Review Items")
    write_row(review, headers + ["Notes"], 1, header=True)
    row_index = 2
    for transaction in transactions:
        if transaction.review_status == "needs_review" or transaction.confidence < 80:
            write_row(
                review,
                [
                    transaction.transaction_date,
                    transaction.description,
                    transaction.debit_amount,
                    transaction.credit_amount,
                    transaction.running_balance,
                    transaction.account_category,
                    transaction.vat_treatment,
                    transaction.confidence,
                    transaction.review_status,
                    transaction.notes,
                ],
                row_index,
            )
            row_index += 1

    notes = workbook.create_sheet("Assumptions and Notes")
    write_row(notes, ["Assumption", "Detail"], 1, header=True)
    write_row(notes, ["Bank support", "Phase 1 supports FNB South Africa business bank statement PDFs only."], 2)
    write_row(notes, ["Extraction", "Deterministic pdfplumber extraction with PyMuPDF fallback."], 3)
    write_row(notes, ["AI use", "AI is reserved for unclear descriptions when configured; no AI is required for deterministic matches."], 4)
    write_row(notes, ["Review", "Every transaction includes confidence and review status."], 5)

    for sheet in workbook.worksheets:
        for column_cells in sheet.columns:
            max_length = max(len(str(cell.value or "")) for cell in column_cells)
            sheet.column_dimensions[column_cells[0].column_letter].width = min(max(max_length + 2, 12), 42)

    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
        },
    )


@app.post("/process-fnb-statement")
def process_fnb_statement(payload: ProcessRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    verify_worker_token(authorization)
    supabase = get_supabase()
    bucket = os.getenv("SUPABASE_BUCKET", "documents")

    log_event(
        "worker.process_request",
        run_id=payload.run_id,
        workspace_id=payload.workspace_id,
        document_id=payload.document_id,
        processing_job_id=payload.processing_job_id,
        storage_path=payload.storage_path,
        bucket=bucket,
    )

    try:
        pdf_bytes = supabase.storage.from_(bucket).download(payload.storage_path)
        log_event("worker.storage_downloaded", run_id=payload.run_id, bytes=len(pdf_bytes))
        pages = extract_statement_text(pdf_bytes)
        full_text = "\n".join(page["text"] for page in pages)
        log_event(
            "worker.text_extracted",
            run_id=payload.run_id,
            pages=len(pages),
            characters=len(full_text),
        )
        metadata = parse_metadata(full_text)
        transactions = parse_transactions(pages, metadata)
        log_event(
            "worker.statement_parsed",
            run_id=payload.run_id,
            metadata_fields=sorted([key for key, value in metadata.items() if value is not None]),
            transactions=len(transactions),
        )

        if not transactions:
            diagnostics = extraction_diagnostics(pages, full_text)
            log_warning("worker.no_transactions_parsed", run_id=payload.run_id, diagnostics=diagnostics)
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "No FNB transactions could be parsed from this PDF.",
                    "diagnostics": diagnostics,
                },
            )

        validation = validate_statement(metadata, transactions)
        log_event(
            "worker.statement_validated",
            run_id=payload.run_id,
            validation={key: str(value) for key, value in validation.items()},
        )

        supabase.table("accounting_transactions").delete().eq("run_id", payload.run_id).execute()
        rows = [
            {
                **transaction.model_dump(),
                "run_id": payload.run_id,
                "workspace_id": payload.workspace_id,
            }
            for transaction in transactions
        ]
        supabase.table("accounting_transactions").insert(rows).execute()

        workbook_bytes = build_workbook(metadata, transactions)
        workbook_path = f"{payload.workspace_id}/accounting/fnb/exports/{payload.run_id}.xlsx"
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

        bank_charges_total = sum(transaction.debit_amount or 0 for transaction in transactions if transaction.bank_charge)
        avg_confidence = sum(transaction.confidence for transaction in transactions) / len(transactions)
        status = "review" if any(transaction.review_status == "needs_review" for transaction in transactions) else "completed"

        supabase.table("accounting_statement_runs").update(
            {
                **metadata,
                "status": status,
                "transaction_count": len(transactions),
                "bank_charges_total": bank_charges_total,
                "workbook_storage_path": workbook_path,
                "confidence": round(avg_confidence, 2),
                "error": None,
                "updated_at": datetime.utcnow().isoformat(),
            }
        ).eq("id", payload.run_id).eq("workspace_id", payload.workspace_id).execute()

        if payload.processing_job_id:
            supabase.table("processing_jobs").update(
                {
                    "status": "completed",
                    "progress": 100,
                    "message": "Accounting workbook ready",
                    "error": None,
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
        )

        return {
            "status": status,
            "transactions": len(transactions),
            "workbook_storage_path": workbook_path,
            "confidence": round(avg_confidence, 2),
        }
    except HTTPException as exc:
        message = json.dumps(exc.detail, default=str) if isinstance(exc.detail, (dict, list)) else str(exc.detail)
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
        raise HTTPException(status_code=422, detail=message) from exc
