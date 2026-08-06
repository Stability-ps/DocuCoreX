"""Bank-independent statement reading: text in, structured rows out.

This module deliberately stops at rows. It produces the same StructuredRow
shape that Azure and Mistral produce — {"pageNumber", "cells": {...}, "raw"} —
so the text path and the structured-provider path converge on ONE downstream
transformer, main.parse_structured_rows. Everything that turns a row into a
transaction already lives there and is already bank-independent: date
inheritance, Dr/Cr suffixes, bracketed negatives, zero-value informational rows,
and resolving an unsigned amount's direction from running-balance continuity.

Writing a second transformer here would mean a second set of those rules,
drifting from the first.

What text alone cannot tell you
-------------------------------
On a two-column layout (Payments/Deposits, Debit/Credit, Money out/Money in)
the empty column collapses when a PDF is flattened to text, so

    02 May 25 SALARY DEPOSIT 45,000.00 -948,997.12

gives no clue whether 45,000.00 was printed under Payments or Deposits. The
column position is simply gone. So this parser does not guess: it emits the
figure as `amount` and leaves the direction to balance continuity downstream,
which reads it off the arithmetic instead — the balance rose by exactly the
amount, so it was a deposit. Where the text DOES carry a sign (a Dr/Cr suffix,
a minus, brackets, or both columns printed with one as 0.00) that evidence is
used and continuity is not consulted.

Extracted tables, when a PDF yields them, keep their true column positions and
are read by main.parse_table_transactions instead.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .lexicon import LOOSE_DATE, MONEY_TOKEN

# Column roles, recognised from the statement's own header row.
ROLE_DATE = "date"
ROLE_DESCRIPTION = "description"
ROLE_DEBIT = "debit"
ROLE_CREDIT = "credit"
ROLE_AMOUNT = "amount"
ROLE_BALANCE = "balance"

_HEADER_ROLE_TOKENS: tuple[tuple[str, tuple[str, ...]], ...] = (
    # Order matters: "money out" must be tested before the bare "money".
    (ROLE_DATE, ("date", "trans date", "transaction date", "posting date", "value date")),
    (ROLE_DEBIT, ("payments", "payment", "debit", "debits", "withdrawal", "withdrawals", "money out", "paid out")),
    (ROLE_CREDIT, ("deposits", "deposit", "credit", "credits", "money in", "paid in", "receipts")),
    (ROLE_BALANCE, ("balance", "running balance", "closing balance")),
    (ROLE_AMOUNT, ("amount", "transaction amount", "value")),
    (ROLE_DESCRIPTION, ("description", "details", "narrative", "transaction", "reference", "particulars")),
)

# Lines that are furniture, not ledger rows. A statement repeats its header and
# its page chrome on every page, and prints totals in the same column positions
# as transactions, so "has a date and an amount" is not sufficient on its own.
_FURNITURE = re.compile(
    r"\b(?:"
    r"page\s+\d+\s*(?:of\s+\d+)?"
    r"|statement\s+(?:period|number|date|summary)"
    r"|opening\s+balance|closing\s+balance|balance\s+(?:brought|carried)\s+forward"
    r"|total\s+(?:payments|deposits|debits|credits|fees|charges)?"
    r"|sub\s*total|vat\s+summary|interest\s+summary"
    r"|customer\s+care|contact\s+(?:us|centre)|call\s+centre"
    r"|www\.|https?://|@[a-z0-9.-]+\.[a-z]{2,}"
    r"|(?:reg|vat|vat\s+reg)\.?\s*(?:no|number)\b"
    r"|continued\s+(?:on|overleaf)|end\s+of\s+statement"
    r")\b",
    re.IGNORECASE,
)

# A statement's own summary block repeats amounts that are not transactions.
_SUMMARY_LINE = re.compile(
    r"^\s*(?:total|totals|sub\s*total|summary|turnover|vat|interest|closing|opening|brought|carried)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ColumnLayout:
    """The money columns this statement prints, read from its header row."""

    roles: tuple[str, ...]
    header_line: str

    @property
    def has_paired_columns(self) -> bool:
        return ROLE_DEBIT in self.roles and ROLE_CREDIT in self.roles

    @property
    def has_balance(self) -> bool:
        return ROLE_BALANCE in self.roles


def _normalise(line: str) -> str:
    return re.sub(r"\s+", " ", (line or "").replace(" ", " ")).strip()


def header_roles(line: str) -> tuple[str, ...]:
    """Read column roles off a candidate header line, left to right.

    Returns an empty tuple when the line is not a header. A header must name a
    date column and at least one money column — a bare "Description" line in a
    letterhead is not a transaction table.
    """
    lowered = _normalise(line).lower()
    if not lowered or MONEY_TOKEN.search(lowered):
        # A header row carries no figures. A line with amounts on it is a
        # transaction, however header-like its words.
        return ()

    found: list[tuple[int, str]] = []
    claimed: list[tuple[int, int]] = []
    for role, tokens in _HEADER_ROLE_TOKENS:
        for token in sorted(tokens, key=len, reverse=True):
            for match in re.finditer(rf"\b{re.escape(token)}\b", lowered):
                span = (match.start(), match.end())
                if any(start < span[1] and span[0] < end for start, end in claimed):
                    continue
                claimed.append(span)
                found.append((span[0], role))
                break
            else:
                continue
            break

    roles = tuple(role for _, role in sorted(found))
    if ROLE_DATE not in roles:
        return ()
    if not any(role in roles for role in (ROLE_DEBIT, ROLE_CREDIT, ROLE_AMOUNT, ROLE_BALANCE)):
        return ()
    return roles


def is_furniture(line: str) -> bool:
    """Page chrome, headers and summary blocks — never ledger rows."""
    normalised = _normalise(line)
    if not normalised:
        return True
    if header_roles(normalised):
        return True
    if _SUMMARY_LINE.match(normalised):
        return True
    return bool(_FURNITURE.search(normalised))


def _money_matches(line: str) -> list[re.Match[str]]:
    return list(MONEY_TOKEN.finditer(line))


def _leading_date(line: str) -> re.Match[str] | None:
    match = LOOSE_DATE.match(line)
    return match if match else None


def detect_layout(lines: list[str]) -> ColumnLayout | None:
    """Find the statement's transaction-table header, if it prints one."""
    for line in lines:
        roles = header_roles(line)
        if roles:
            return ColumnLayout(roles=roles, header_line=_normalise(line))
    return None


def _split_money_roles(
    matches: list[re.Match[str]],
    layout: ColumnLayout | None,
) -> tuple[str | None, str | None]:
    """Decide what the trailing figures on a line mean.

    Returns (amount_text, balance_text). Only the LAST figure can be a running
    balance, and only when the statement prints a balance column at all.
    """
    if not matches:
        return None, None

    texts = [match.group(0).strip() for match in matches]
    prints_balance = layout.has_balance if layout else True

    if len(texts) == 1:
        # One figure: a balance column means this is a balance-only row
        # (informational); no balance column means it is the amount.
        return (None, texts[0]) if prints_balance else (texts[0], None)

    if not prints_balance:
        return texts[-1], None

    balance_text = texts[-1]
    remaining = texts[:-1]
    if len(remaining) == 1:
        return remaining[0], balance_text

    # Both money columns printed, one of them zero (a statement that prints
    # 0.00 rather than leaving the cell blank). The non-zero figure is the
    # movement; if both are zero the row is informational and either will do.
    non_zero = [text for text in remaining if not _is_zero(text)]
    if len(non_zero) == 1:
        return non_zero[0], balance_text
    return remaining[-1], balance_text


def _row_has_money(row: dict[str, Any]) -> bool:
    cells = row.get("cells") or {}
    return bool(cells.get(ROLE_AMOUNT) or cells.get(ROLE_BALANCE) or cells.get(ROLE_DEBIT) or cells.get(ROLE_CREDIT))


def _is_zero(text: str) -> bool:
    match = MONEY_TOKEN.search(text)
    if not match:
        return False
    try:
        return float(match.group("amount").replace(",", "")) == 0.0
    except ValueError:
        return False


def extract_generic_rows(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Read a statement of any bank into StructuredRow dictionaries.

    Line handling, in the order a statement actually prints:

    - a line starting with a date opens a new row;
    - a dateless line carrying figures is a grouped movement — banks print the
      date once per date group — and inherits the open row's date;
    - a dateless line with no figures is a wrapped description and is appended
      to the row above;
    - furniture is dropped, and it also closes the open row so a wrapped
      description cannot jump across a page break onto an unrelated statement.
    """
    rows: list[dict[str, Any]] = []
    all_lines = [_normalise(line) for page in pages for line in (page.get("text") or "").splitlines()]
    layout = detect_layout(all_lines)

    for page in pages:
        page_number = page.get("page")
        last_date = ""
        open_row: dict[str, Any] | None = None

        def close() -> None:
            nonlocal open_row
            if open_row is not None:
                rows.append(open_row)
                open_row = None

        for raw_line in (page.get("text") or "").splitlines():
            line = _normalise(raw_line)
            if not line:
                continue
            if is_furniture(line):
                close()
                continue

            money = _money_matches(line)
            date_match = _leading_date(line)

            if not date_match and not money:
                # A wrapped description. Only ever appended to an open row —
                # never allowed to start one.
                if open_row is not None:
                    open_row["cells"][ROLE_DESCRIPTION] = _normalise(
                        f"{open_row['cells'].get(ROLE_DESCRIPTION, '')} {line}"
                    )
                    open_row["raw"] = f"{open_row['raw']} {line}".strip()
                continue

            if not date_match and not last_date:
                # Figures before the statement's first dated row: not a ledger row.
                continue

            if not date_match and open_row is not None and not _row_has_money(open_row):
                # A description that wrapped, with the figures printed on its
                # second line. Distinguishable from a grouped movement — a
                # separate transaction sharing the date above — by whether the
                # open row already carries figures of its own. Treating this as a
                # new row would split one transaction into a description with no
                # amount and an amount with a fragment of a description.
                body_money = _money_matches(line)
                amount_text, balance_text = _split_money_roles(body_money, layout)
                description_end = body_money[0].start() if body_money else len(line)
                open_row["cells"][ROLE_DESCRIPTION] = _normalise(
                    f"{open_row['cells'].get(ROLE_DESCRIPTION, '')} {line[:description_end]}"
                )
                if amount_text:
                    open_row["cells"][ROLE_AMOUNT] = amount_text
                if balance_text:
                    open_row["cells"][ROLE_BALANCE] = balance_text
                open_row["raw"] = f"{open_row['raw']} {line}".strip()
                continue

            close()

            if date_match:
                last_date = date_match.group("date")
                body = line[date_match.end():]
            else:
                body = line

            body_money = _money_matches(body)
            amount_text, balance_text = _split_money_roles(body_money, layout)
            description_end = body_money[0].start() if body_money else len(body)
            description = _normalise(body[:description_end])

            cells: dict[str, str] = {ROLE_DATE: last_date, ROLE_DESCRIPTION: description}
            if amount_text:
                cells[ROLE_AMOUNT] = amount_text
            if balance_text:
                cells[ROLE_BALANCE] = balance_text

            open_row = {"pageNumber": page_number, "cells": cells, "raw": line}

        close()

    return rows


def count_candidate_lines(text: str) -> int:
    """How many ledger rows this text would yield — a bank-independent count.

    Used to compare two extractions of the same statement. The FNB counter is
    gated on FNB's "Transactions in RAND" heading and returns 0 for every other
    bank, which made the worker discard a 78,000-character Mistral extraction of
    a Standard Bank statement in favour of its own.
    """
    pages = [{"page": 1, "text": text or "", "tables": []}]
    return len(extract_generic_rows(pages))
