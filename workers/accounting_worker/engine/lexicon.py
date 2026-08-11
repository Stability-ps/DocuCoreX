"""Lexical patterns shared by every parser.

These live here so the FNB parser and the generic parser tokenise a statement
the same way. A second, subtly different money or date regex in the generic
parser would drift from this one, and the two parsers would then disagree about
what a row even is.

main.py re-exports these under their original names; nothing else changed about
how they are used.
"""

from __future__ import annotations

import re

# A money amount with its sign carriers: leading minus, R prefix, bracketed
# negative, and a trailing Cr/Dr marker. Group names are consumed by callers.
MONEY_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])(?P<negative>-)?(?:R\s*)?(?P<bracket>\()?(?P<amount>(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?:\))?\s*(?P<suffix>Cr|CR|Dr|DR)?(?!\d)",
    re.IGNORECASE,
)

# A date in any of the layouts South African banks print: 01/04/2025, 01-04-25,
# 01 Apr, 01 Apr 2025, 30 Apr 25.
#
# The year group's lookahead is load-bearing. Without it, a descriptionless row
# ("26 Apr 550.00 148,157.78Cr") matched its date as "26 Apr 550" — taking the
# integer part of the amount as a year — and the row was dropped. A real year is
# never followed by a digit, decimal point or thousands comma.
LOOSE_DATE = re.compile(
    r"(?P<date>\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4}(?![\d.,]))?|\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{2,4}(?![\d.,]))?)"
)

# A permissive money match used where only the position of an amount matters.
LOOSE_MONEY = re.compile(r"(?:R\s*)?-?\(?\d[\d,\s]*\.\d{2}\)?-?")

# FNB's transaction-section heading, matched WITHOUT depending on its spacing.
#
# Whether a space survives between "in" and "RAND" is an artifact of the PDF
# text extractor, not of the statement. The same page that yields "Transactions
# in RAND (ZAR)" at one x_tolerance yields "Transactions inRAND (ZAR)" at
# another, because the words are laid out as separate positioned runs and the
# extractor decides whether the gap is wide enough to be a space.
#
# The consequence of matching a literal was total: this heading opens the ONLY
# section the FNB parser reads, so a single missing space put every row outside
# the section and the statement parsed to zero transactions. The same literal
# also scored the FNB bank fingerprint, so the extraction that lost the heading
# lost part of its claim to be an FNB statement at the same time.
#
# \s* rather than \s+ because the missing space is the whole point.
FNB_SECTION_HEADING_PATTERN = r"transactions\s*in\s*rand"
FNB_SECTION_HEADING = re.compile(FNB_SECTION_HEADING_PATTERN, re.IGNORECASE)
