"""Sanitised FNB statement PDFs, generated at test time.

The real-statement regression cases point at two actual FNB business statements
held on one developer's machine, by absolute path. They are real financial
documents and correctly are not in the repository, so the suite could only pass
there — CI and every other developer got "no real statement was opened".

These fixtures restore that coverage everywhere. Every figure, name and account
number below is invented; nothing here derives from a real statement. The
statements are built as text, rendered to a genuine PDF with PyMuPDF (already a
worker dependency), and read back through pdfplumber, so the case still
exercises the full pipeline: PDF bytes -> pdfplumber text -> parse_metadata ->
parse_fnb_transactions -> validate_statement -> extraction confidence.

What they deliberately do NOT replace: the real statements carry FNB's actual
layout quirks — column positions, wrapped descriptions, repeated page headers —
and pdfplumber's behaviour on them is what the parser was fixed for. A rendered
fixture cannot reproduce that. The real cases therefore still run when the files
are present; these run always.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any


def _money(value: Decimal) -> str:
    return f"{value:,.2f}"


def _balance_cell(value: Decimal) -> str:
    """FNB prints Cr for a positive balance; an overdrawn balance prints as a
    magnitude with no suffix. Both appear below so the fixture covers each."""
    return f"{_money(value)} Cr" if value >= 0 else _money(value.copy_abs())


def _build_statement_lines(
    *,
    company: str,
    account: str,
    period: str,
    statement_date: str,
    opening: Decimal,
    credits: list[tuple[str, str, Decimal]],
    debits: list[tuple[str, str, Decimal]],
) -> tuple[list[str], dict[str, Decimal]]:
    """Interleave credits and debits the way a statement prints them, tracking the
    running balance so the ledger genuinely reconciles rather than merely looking
    like it does."""
    balance = opening
    body: list[str] = []

    # Alternate so the running balance moves in both directions and, for the
    # overdrawn fixture, crosses zero part-way through.
    ordered: list[tuple[str, str, Decimal, bool]] = []
    for index in range(max(len(credits), len(debits))):
        if index < len(debits):
            day, desc, amount = debits[index]
            ordered.append((day, desc, amount, False))
        if index < len(credits):
            day, desc, amount = credits[index]
            ordered.append((day, desc, amount, True))

    for day, desc, amount, is_credit in ordered:
        if is_credit:
            balance += amount
            body.append(f"{day} {desc} {_money(amount)}Cr {_balance_cell(balance)}")
        else:
            balance -= amount
            body.append(f"{day} {desc} {_money(amount)} {_balance_cell(balance)}")

    credit_total = sum((amount for _, _, amount in credits), Decimal("0"))
    debit_total = sum((amount for _, _, amount in debits), Decimal("0"))

    header = [
        "FIRST NATIONAL BANK",
        "A division of FirstRand Bank Limited",
        f"{company}",
        "12 Example Road",
        "Testville 0001",
        f"Account Number: {account}",
        f"Statement Number: {statement_date.replace(' ', '')}-001",
        f"Statement Date: {statement_date}",
        f"Statement Period: {period}",
        "",
        "Transactions in Rand (ZAR)",
        f"Opening Balance {_balance_cell(opening)}",
    ]

    footer = [
        f"Closing Balance {_balance_cell(balance)}",
        "Turnover for Statement Period",
        f"Credit Transactions {len(credits)} R{_money(credit_total)}",
        f"Debit Transactions {len(debits)} R{_money(debit_total)}",
    ]

    expected = {
        "credits": credit_total,
        "debits": debit_total,
        "closing": balance,
    }
    return [*header, *body, *footer], expected


def _render_pdf(lines: list[str], destination: Path) -> Path:
    """Render to a real PDF. A monospaced font at a fixed left margin keeps the
    extracted text one statement row per line, which is what the text-section
    parser consumes."""
    import fitz  # PyMuPDF, already required by the worker

    document = fitz.open()
    margin_x, margin_top, leading, font_size = 40, 55, 11.5, 8.0
    rows_per_page = 62

    for start in range(0, len(lines), rows_per_page):
        page = document.new_page()
        y = margin_top
        for line in lines[start : start + rows_per_page]:
            if line:
                page.insert_text((margin_x, y), line, fontsize=font_size, fontname="cour")
            y += leading

    destination.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(destination))
    document.close()
    return destination


def _reconciling_statement() -> tuple[list[str], dict[str, Decimal]]:
    """A clean statement that reconciles exactly: every row lands on the printed
    balance and the declared totals match the ledger."""
    credits = [
        ("0{} Apr".format(i + 1), f"Eft Credit Client Invoice {4100 + i}", Decimal("18500.00"))
        for i in range(6)
    ]
    credits.append(("09 Apr", "Eft Credit Client Invoice 4106", Decimal("7250.45")))

    debits = [
        ("0{} Apr".format(i + 1), f"Card Purchase Supplier {2200 + i}", Decimal("3125.50"))
        for i in range(9)
    ]
    debits.append(("11 Apr", "Internal Debit Order Insurance Premium", Decimal("4880.15")))
    debits.append(("12 Apr", "Monthly Account Fee", Decimal("310.00")))

    return _build_statement_lines(
        company="Sanitised Trading (Pty) Ltd",
        account="6200000001",
        period="01 April 2026 to 30 April 2026",
        statement_date="30 April 2026",
        opening=Decimal("12500.00"),
        credits=credits,
        debits=debits,
    )


def _overdrawn_statement() -> tuple[list[str], dict[str, Decimal]]:
    """Drives the balance negative early, so the fixture covers the overdrawn
    balance format — printed as a magnitude with no Cr suffix — which is the
    shape that once caused rows to be dropped."""
    debits = [
        ("01 May", "Internal Debit Order Facility Fee 118841", Decimal("676.02")),
        ("01 May", "Internal Debit Order Facility Fee 118842", Decimal("696.30")),
        ("02 May", "#Excess Item Fee 2 Items On 26/05/01", Decimal("310.00")),
    ]
    debits.extend(
        ("0{} May".format((i % 9) + 1), f"Card Purchase Supplier {3300 + i}", Decimal("2410.75"))
        for i in range(12)
    )

    credits = [
        ("0{} May".format((i % 9) + 1), f"Eft Credit Client Settlement {i:03d}", Decimal("9400.00"))
        for i in range(5)
    ]
    credits.append(("14 May", "Eft Credit Client Settlement 005", Decimal("3182.07")))

    return _build_statement_lines(
        company="Sanitised Trading (Pty) Ltd",
        account="6200000002",
        period="01 May 2026 to 31 May 2026",
        statement_date="31 May 2026",
        opening=Decimal("1200.00"),
        credits=credits,
        debits=debits,
    )


def build_sanitised_cases(directory: Path) -> list[dict[str, Any]]:
    """Generate the fixture PDFs and return them in the shape the regression
    suite's real-statement cases use."""
    builders = [
        ("sanitised-reconciling", _reconciling_statement),
        ("sanitised-overdrawn", _overdrawn_statement),
    ]

    cases: list[dict[str, Any]] = []
    for case_id, builder in builders:
        lines, expected = builder()
        path = _render_pdf(lines, directory / f"{case_id}.pdf")
        cases.append(
            {
                "id": case_id,
                "path": path,
                "credits": str(expected["credits"]),
                "debits": str(expected["debits"]),
                "closing": str(expected["closing"]),
            }
        )
    return cases
