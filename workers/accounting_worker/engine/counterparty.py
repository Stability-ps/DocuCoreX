"""Who a transaction was with, and what the statement itself proves about them.

The production baseline found 426 of 615 rows unresolved — 69% of a real
statement parked in Suspense because no global rule named the counterparty. The
instinct is to grow the merchant list. That instinct is what put one customer's
suppliers into every workspace's AI prompt, and it does not scale: a merchant
list can only ever know the merchants someone has already taught it.

The statement knows more than the list does. Of those 426 rows, 369 (87%) name a
counterparty that appears at least twice in the same statement, and across the
38 counterparties with two or more rows, ALL 38 move money in a single
consistent direction. Six months of identical R19,086.55 debits to ABSA BANK is
evidence. Sixty-seven credits from one payer totalling R3.7m is evidence. None
of it required knowing the name in advance.

So this module answers two questions the bank's own wording can settle:

  WHO           strip the channel wording and the card mask, and what remains is
                the counterparty — extracted, never guessed, using only words
                the description actually contains.

  WHAT IS PROVEN  group a counterparty's rows and measure what recurs: how
                often, over how long, in which direction, at what amounts.

It deliberately does NOT answer what the transaction should be booked to.
Recurrence proves a trading RELATIONSHIP exists; it says nothing about whether
the goods were stock, groceries or repairs. Confusing those two is how a fuel
retailer's name came to authorise a VAT claim. Category and VAT stay where they
are — decided by evidence about the purchase, not about the payee.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Iterable, Sequence

# Bank channel wording: HOW money moved, never WHO was paid.
#
# This is the same distinction §6 of the VAT audit established. "CHEQUE CARD
# PURCHASE" appears on 291 of 615 rows here; if it were allowed into the
# counterparty key, 291 unrelated purchases would collapse into one imaginary
# merchant. Ordered longest-first so "IB TRANSFER FROM" is removed as a phrase
# rather than leaving a stray "FROM" behind.
CHANNEL_PHRASES: tuple[str, ...] = (
    "OUTSTANDING CARD AUTHORISATION",
    "OTHER BANK ATM CASH WITHD. AT",
    "OTHER BANK ATM CASH WITHD AT",
    "ELECTRONIC BANKING COLLECT TO",
    "INTERNET BANKING PAYMENT TO",
    "INTERNET BANKING PAYMENT",
    "CHEQUE CARD PURCHASE",
    "IMMEDIATE PAYMENT RECEIVED",
    "MAGTAPE DEBIT",
    "MAGTAPE CREDIT",
    "IB PAYMENT FROM",
    "IB TRANSFER FROM",
    "IB TRANSFER TO",
    "IB PAYMENT TO",
    "ACCOUNT PAYMENT",
    "IMMEDIATE PAYMENT",
    "CREDIT TRANSFER",
    "DEBIT TRANSFER",
    "CARD PURCHASE",
    "POS PURCHASE",
    "DEBIT ORDER",
    "CASH DEPOSIT",
    "AUTOBANK",
    "PAYSHAP",
)

# A card mask as Standard Bank prints it: 4278*5999. It abuts the merchant name
# with no separator when the name fills the field, which is also the signal that
# the bank TRUNCATED the name — "GOLDWAGEN HILT4278*5999" is Goldwagen Hilton
# cut at 14 characters. Worth knowing, because a truncated name must never be
# treated as a complete one.
CARD_MASK = re.compile(r"\d{4}\*\d{4}")
TIME_STAMP = re.compile(r"\b\d{1,2}H\d{2}\b")
LONG_REFERENCE = re.compile(r"\b[A-Z]{0,4}\d{5,}[A-Z0-9]*\b")
TRAILING_REFERENCE = re.compile(r"\s+\d{2,}$")

# The width at which this bank truncates the counterparty field.
TRUNCATION_WIDTH = 14


@dataclass(frozen=True)
class Counterparty:
    """Who the row was with, as far as the statement can prove."""

    key: str
    """Normalised identity used for grouping. Lower case, collapsed whitespace."""
    display: str
    """As printed, using only words present in the description."""
    channel: str | None
    """The bank wording removed to find the name, kept for explanation."""
    truncated: bool
    """The bank cut the name short, so it is a prefix and not a full name."""


def extract_counterparty(description: str | None) -> Counterparty | None:
    """The counterparty behind the bank's wording, or None.

    None is a real answer and the honest one for ". 08H29 IB TRANSFER TO", which
    names nobody: an own-account transfer where the bank recorded only a time.
    Returning a guess there would manufacture a merchant out of a timestamp.
    """
    if not description:
        return None
    text = " ".join(str(description).upper().split())
    if not text:
        return None

    channel = None
    for phrase in CHANNEL_PHRASES:
        if phrase in text:
            channel = phrase
            text = text.replace(phrase, " ")
            break

    truncated = bool(CARD_MASK.search(text)) and _abuts_mask(text)
    text = CARD_MASK.sub(" ", text)
    text = TIME_STAMP.sub(" ", text)
    text = LONG_REFERENCE.sub(" ", text)
    text = TRAILING_REFERENCE.sub(" ", text)

    # Punctuation the bank uses as filler, not as part of a name. "*" is kept
    # inside a token (HPY*MADEIRA) because acquirers print it that way, but a
    # bare "." or "*" standing alone is noise.
    tokens = [tok.strip(".,;:-") for tok in text.split()]
    tokens = [_strip_fused_reference(tok) for tok in tokens]
    tokens = [tok for tok in tokens if tok and tok not in {"*", "-", "."} and not tok.isdigit()]
    if not tokens:
        return None

    display = " ".join(tokens)
    if len(display) < 2:
        return None
    return Counterparty(key=display.lower(), display=display, channel=channel, truncated=truncated)


FUSED_REFERENCE = re.compile(r"^([A-Z][A-Z&'/*.-]*?)(\d{4,})$")


def _strip_fused_reference(token: str) -> str:
    """Cut a reference number off the end of a name it was printed against.

    "A HARMONY698002 CREDIT TRANSFER" is payer A HARMONY with reference 698002,
    not a payer called HARMONY698002 — and left fused, every one of the 67
    payments from that customer would key differently and the recurrence they
    prove together would be invisible.

    Four digits minimum, and only where letters come first. A short trailing
    number is usually part of the name a bank prints (N1, N3, SIXTY60), and a
    token that is all digits is handled by the caller.
    """
    match = FUSED_REFERENCE.match(token)
    if not match:
        return token
    name = match.group(1)
    # Refuse to cut a name down to nothing meaningful — better to keep the
    # token whole than to invent a one-letter counterparty.
    return name if len(name) >= 2 else token


def _abuts_mask(text: str) -> bool:
    """Did the name run straight into the card mask, with no space?

    That is the bank filling its fixed-width field, which means the name was cut.
    """
    match = CARD_MASK.search(text)
    if not match or match.start() == 0:
        return False
    return text[match.start() - 1] not in " \t"


@dataclass(frozen=True)
class CounterpartyEvidence:
    """What a statement proves about one counterparty. Facts only, no verdict."""

    key: str
    display: str
    occurrences: int
    debit_count: int
    credit_count: int
    total_debit: Decimal
    total_credit: Decimal
    median_amount: Decimal
    amount_spread: Decimal
    """Largest amount divided by smallest. 1 means every movement is identical."""
    months_spanned: int
    first_seen: str | None
    last_seen: str | None
    truncated_name: bool
    reasons: tuple[str, ...] = field(default=())

    @property
    def single_direction(self) -> bool:
        return bool(self.occurrences) and (self.debit_count == 0 or self.credit_count == 0)

    @property
    def recurring(self) -> bool:
        """Seen in three or more distinct months.

        Two occurrences can be coincidence; a pattern across three separate
        months is a standing arrangement. The threshold is deliberately not one
        or two — a supplier paid twice in a week is not yet a relationship.
        """
        return self.months_spanned >= 3

    @property
    def fixed_amount(self) -> bool:
        """Every movement the same size, within a hair.

        The signature of an instalment, subscription or debit order, as opposed
        to trade purchases that vary with what was bought.
        """
        return self.occurrences >= 2 and self.amount_spread <= Decimal("1.05")


def _amount(row: Any, name: str) -> Decimal:
    value = row.get(name) if isinstance(row, dict) else getattr(row, name, None)
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def _field(row: Any, name: str) -> Any:
    return row.get(name) if isinstance(row, dict) else getattr(row, name, None)


def counterparty_evidence(key: str, display: str, rows: Sequence[Any]) -> CounterpartyEvidence:
    """Measure what recurs for one counterparty. Every number is observed."""
    debits = [_amount(r, "debit_amount") for r in rows]
    credits = [_amount(r, "credit_amount") for r in rows]
    debit_count = sum(1 for d in debits if d > 0)
    credit_count = sum(1 for c in credits if c > 0)

    amounts = sorted(max(d, c) for d, c in zip(debits, credits) if max(d, c) > 0)
    median = amounts[len(amounts) // 2] if amounts else Decimal("0")
    spread = (amounts[-1] / amounts[0]) if amounts and amounts[0] > 0 else Decimal("0")

    dates = sorted(str(_field(r, "transaction_date") or "") for r in rows if _field(r, "transaction_date"))
    months = {d[:7] for d in dates if len(d) >= 7}

    evidence = CounterpartyEvidence(
        key=key,
        display=display,
        occurrences=len(rows),
        debit_count=debit_count,
        credit_count=credit_count,
        total_debit=sum(debits, Decimal("0")),
        total_credit=sum(credits, Decimal("0")),
        median_amount=median,
        amount_spread=spread,
        months_spanned=len(months),
        first_seen=dates[0] if dates else None,
        last_seen=dates[-1] if dates else None,
        truncated_name=any(bool(_field(r, "counterparty_truncated")) for r in rows),
    )
    return _with_reasons(evidence)


def _with_reasons(evidence: CounterpartyEvidence) -> CounterpartyEvidence:
    """State the evidence in words a reviewer can check against the statement."""
    reasons: list[str] = []
    if evidence.occurrences >= 2:
        reasons.append(f"{evidence.occurrences} transactions with this counterparty")
    if evidence.single_direction and evidence.occurrences >= 2:
        way = "only ever paid out" if evidence.debit_count else "only ever received"
        reasons.append(f"money {way}")
    if evidence.recurring:
        reasons.append(f"recurring across {evidence.months_spanned} months")
    if evidence.fixed_amount:
        reasons.append(f"identical amount each time ({evidence.median_amount})")
    if evidence.truncated_name:
        reasons.append("name truncated by the bank")
    return CounterpartyEvidence(**{**evidence.__dict__, "reasons": tuple(reasons)})


def group_by_counterparty(rows: Iterable[Any]) -> dict[str, list[Any]]:
    """Bucket rows by extracted counterparty. Rows naming nobody are excluded."""
    groups: dict[str, list[Any]] = {}
    for row in rows:
        party = extract_counterparty(str(_field(row, "description") or ""))
        if party is None:
            continue
        groups.setdefault(party.key, []).append(row)
    return groups


def evidence_for_all(rows: Iterable[Any]) -> dict[str, CounterpartyEvidence]:
    materialised = list(rows)
    groups = group_by_counterparty(materialised)
    out: dict[str, CounterpartyEvidence] = {}
    for key, group in groups.items():
        party = extract_counterparty(str(_field(group[0], "description") or ""))
        display = party.display if party else key
        out[key] = counterparty_evidence(key, display, group)
    return out


# ── What the evidence supports, and what it does not ────────────────────────

RELATIONSHIP_CUSTOMER = "customer"
RELATIONSHIP_SUPPLIER = "supplier"
RELATIONSHIP_UNKNOWN = "unknown"

RELATIONSHIP_STRENGTH_STRONG = "strong"
RELATIONSHIP_STRENGTH_WEAK = "weak"
RELATIONSHIP_STRENGTH_NONE = "none"


@dataclass(frozen=True)
class Relationship:
    kind: str
    strength: str
    reason: str


def infer_relationship(evidence: CounterpartyEvidence) -> Relationship:
    """Whether this counterparty is someone we buy from or sell to.

    This is a claim about the RELATIONSHIP and nothing else. A supplier
    relationship does not say the payment is an operating expense — it could be
    stock, an asset, or a loan repayment. A customer relationship does not say
    the receipt is revenue — it could be a refund or a deposit returned. The
    caller still has to decide the account, and the point of this function is to
    give it a fact it did not have rather than a conclusion it did not earn.

    A single transaction proves nothing: one payment out is a payment out, not a
    supplier. Two or more in a consistent direction is the minimum, and three
    months makes it strong.
    """
    if evidence.occurrences < 2 or not evidence.single_direction:
        return Relationship(RELATIONSHIP_UNKNOWN, RELATIONSHIP_STRENGTH_NONE,
                            "a single movement, or money flowing both ways, proves no relationship")

    kind = RELATIONSHIP_SUPPLIER if evidence.debit_count else RELATIONSHIP_CUSTOMER
    strength = RELATIONSHIP_STRENGTH_STRONG if evidence.recurring else RELATIONSHIP_STRENGTH_WEAK
    return Relationship(kind, strength, "; ".join(evidence.reasons))
