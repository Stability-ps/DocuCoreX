"""AI-assisted recovery of a ledger, with fabrication mechanically prevented.

This runs only when every deterministic path has produced nothing and material
is still left to work from. It is the last recovery step before a run is called
unprocessable.

The instruction "do not invent transactions" is not a control. A model asked to
read a statement it cannot quite parse will produce plausible rows, and
plausible rows in an accounting ledger are worse than no rows at all: they
reconcile badly, they look like real figures, and a person reviewing them has no
way to tell which came from the document.

So nothing the model returns is trusted on its word. Every row must name the
source line it came from, and this module verifies against the source material:

  * the source line must exist in what we actually sent;
  * the amount must appear in that line;
  * the balance, if given, must appear in that line;
  * every substantial word of the description must appear in that line.

A row failing any of those is dropped and counted, not repaired. What survives
is evidence the model located, not text it produced — and it is still marked for
review, because located is not the same as understood.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .lexicon import LOOSE_DATE, MONEY_TOKEN

# Batching keeps a long statement inside one model context. Lines are the unit
# because a ledger row is a line; a batch boundary can split a date group, which
# costs the inherited date on the first row of the next batch and nothing else.
LINES_PER_BATCH = 150
MAX_BATCHES = 12

SYSTEM_PROMPT = (
    "You recover bank-statement ledger rows from text that a deterministic parser could not lay out. "
    "You are a locator, not an author. Every figure you return must be copied verbatim from the input. "
    "Output valid JSON only."
)

INSTRUCTIONS = [
    "Return one entry for each ledger row you can locate in the supplied lines.",
    "source_line must be copied EXACTLY from the supplied lines, character for character.",
    "amount and balance must be copied exactly as they appear in that source_line.",
    "description must use only words that appear in that source_line.",
    "Never calculate, infer, correct or complete a figure. If a figure is not printed, omit it.",
    "Do not return a row for a heading, a page number, a summary total, or an opening or closing balance line.",
    "If you are not certain a line is a transaction, omit it. A missing row is recoverable; an invented one is not.",
    "direction must be 'debit' when money leaves the account, 'credit' when it arrives, and 'unknown' when the line does not say.",
    "confidence is your certainty that this line is a transaction row, from 0 to 1.",
]

RESPONSE_SCHEMA = {
    "rows": [
        {
            "source_line": "string, copied exactly from the input",
            "date": "string as printed, or empty if the line has none",
            "description": "string using only words from source_line",
            "amount": "string as printed",
            "balance": "string as printed, or empty",
            "direction": "debit | credit | unknown",
            "confidence": 0.0,
        }
    ]
}


@dataclass
class GroundingReport:
    accepted: list[dict[str, Any]] = field(default_factory=list)
    rejected: dict[str, int] = field(default_factory=dict)

    def reject(self, reason: str) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + 1


def normalise_line(line: str) -> str:
    return re.sub(r"\s+", " ", (line or "").replace(" ", " ")).strip()


def _comparable(text: str) -> str:
    """Whitespace- and case-insensitive form, for comparing a figure to a line."""
    return re.sub(r"\s+", "", (text or "")).lower()


def candidate_lines(text: str, structured_rows: list[dict[str, Any]] | None = None) -> list[str]:
    """The material worth sending: lines that carry a figure.

    A statement's prose, addresses and legal footers cannot be ledger rows, and
    sending them spends context that the actual rows need.
    """
    seen: set[str] = set()
    lines: list[str] = []

    def add(candidate: str) -> None:
        normalised = normalise_line(candidate)
        if not normalised or normalised in seen:
            return
        if not MONEY_TOKEN.search(normalised):
            return
        seen.add(normalised)
        lines.append(normalised)

    for line in (text or "").splitlines():
        add(line)

    for row in structured_rows or []:
        if not isinstance(row, dict):
            continue
        raw = row.get("raw")
        if isinstance(raw, str):
            add(raw)
        cells = row.get("cells")
        if isinstance(cells, dict):
            add(" ".join(str(value) for value in cells.values() if value))

    return lines


def build_prompt(lines: list[str], metadata: dict[str, Any], bank_name: str) -> dict[str, Any]:
    return {
        "task": "Locate the ledger rows printed in these statement lines.",
        "bank": bank_name,
        "statement": {
            "account_number": metadata.get("account_number"),
            "period_start": metadata.get("statement_period_start"),
            "period_end": metadata.get("statement_period_end"),
            "opening_balance": metadata.get("opening_balance"),
            "closing_balance": metadata.get("closing_balance"),
        },
        "instructions": INSTRUCTIONS,
        "response_schema": RESPONSE_SCHEMA,
        "lines": lines,
    }


def batches(lines: list[str]) -> list[list[str]]:
    """Split into model-sized batches, capped. The caller reports any remainder."""
    chunks = [lines[index : index + LINES_PER_BATCH] for index in range(0, len(lines), LINES_PER_BATCH)]
    return chunks[:MAX_BATCHES]


def dropped_line_count(lines: list[str]) -> int:
    """Lines the batch cap left unsent — never silently discarded."""
    return max(0, len(lines) - LINES_PER_BATCH * MAX_BATCHES)


def _description_is_grounded(description: str, source_line: str) -> bool:
    """Every substantial word of the description must be present in the line.

    Short tokens are ignored so that punctuation and joining words do not
    reject a row; anything carrying meaning has to come from the document.
    """
    haystack = re.sub(r"[^a-z0-9]+", " ", source_line.lower())
    haystack_words = set(haystack.split())
    for word in re.sub(r"[^a-z0-9]+", " ", (description or "").lower()).split():
        if len(word) < 3:
            continue
        if word not in haystack_words:
            return False
    return True


def ground_rows(rows: Any, source_lines: list[str]) -> GroundingReport:
    """Keep only what can be traced back to the text we supplied."""
    report = GroundingReport()
    if not isinstance(rows, list):
        return report

    by_comparable = {_comparable(line): line for line in source_lines}

    for row in rows:
        if not isinstance(row, dict):
            report.reject("row_not_an_object")
            continue

        source_line = normalise_line(str(row.get("source_line") or ""))
        if not source_line:
            report.reject("no_source_line")
            continue
        actual_line = by_comparable.get(_comparable(source_line))
        if actual_line is None:
            # The single most important rejection: a line that is not in the
            # document the model was shown.
            report.reject("source_line_not_in_document")
            continue

        amount = normalise_line(str(row.get("amount") or ""))
        if not amount:
            report.reject("no_amount")
            continue
        if _comparable(amount) not in _comparable(actual_line):
            report.reject("amount_not_in_source_line")
            continue

        balance = normalise_line(str(row.get("balance") or ""))
        balance_dropped = False
        if balance and _comparable(balance) not in _comparable(actual_line):
            balance = ""
            balance_dropped = True

        description = normalise_line(str(row.get("description") or ""))
        if not description:
            report.reject("no_description")
            continue
        if not _description_is_grounded(description, actual_line):
            report.reject("description_not_in_source_line")
            continue

        date = normalise_line(str(row.get("date") or ""))
        if date and _comparable(date) not in _comparable(actual_line):
            date_match = LOOSE_DATE.search(actual_line)
            if not date_match:
                report.reject("date_not_in_source_line")
                continue
            date = date_match.group("date")

        direction = str(row.get("direction") or "unknown").strip().lower()
        if direction not in {"debit", "credit", "unknown"}:
            direction = "unknown"

        confidence = row.get("confidence")
        confidence_value = float(confidence) if isinstance(confidence, (int, float)) else 0.0
        confidence_value = max(0.0, min(1.0, confidence_value))

        report.accepted.append(
            {
                "source_line": actual_line,
                "date": date,
                "description": description,
                "amount": amount,
                "balance": balance,
                "direction": direction,
                "confidence": confidence_value,
                "balance_dropped": balance_dropped,
            }
        )

    return report
