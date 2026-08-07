"""High-certainty classification evidence.

Two questions, both answered from the transaction description alone, both
deliberately conservative: is this a charge the BANK imposed, and is this a
withdrawal by the OWNER.

Why these two are singled out
-----------------------------
Bank charges are the most mechanically recognisable category on any statement —
the bank names its own fees — and they were being missed. The keyword list in
classify_transaction listed specific fee names ("service fee", "monthly account
fee") but not the ordinary ones, so "BANK CHARGE", "BANK FEE", "TRANSACTION
FEE", "MONTHLY MANAGEMENT FEE" and "HONOURING FEE" all fell through every rule
to the debit fallback at confidence 55.

Owner drawings is the opposite problem: it was being assigned by default. A
description carrying a payment-channel keyword ("instant money", "payshap", "e
wallet") that matched nothing else returned "Related Party / Drawings", so a
bank fee — "301981485 10H00 FEE - INSTANT MONEY" — was booked as a drawings
movement, out of scope for VAT, on a real statement.

Drawings is a meaningful accounting position. It has to be earned by evidence,
not reached by exhaustion.

The patterns below come from the terminology actually printed by the supported
banks, read off a real 37-page Standard Bank statement and the FNB regression
fixtures — not from a general-purpose fee vocabulary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable

from .categories import canonical_categories, canonicalise_category, is_known_category

# How much weight a classification carries, and therefore what may revise it.
#
# The distinction was previously implicit in a confidence number, which two
# different things were reading as a proxy: the review UI inferred the
# classification's SOURCE from it, and row_needs_ai inferred its TRUSTWORTHINESS
# from it. A number cannot carry both, and it carried neither reliably — a
# merchant-keyword guess and a fee the bank named itself could both score 84.
#
# HARD    the bank's own terminology about the account. Settled.
# LEARNED approved by this workspace against a real correction. Settled.
# SOFT    a useful heuristic — a merchant keyword, a direction guess. Revisable.
# NONE    nothing matched. Unresolved, and it must not read as an answer.
STRENGTH_HARD = "hard"
STRENGTH_LEARNED = "learned"
STRENGTH_SOFT = "soft"
STRENGTH_NONE = "none"

# The strengths a later stage may revise. HARD and LEARNED are not in it, so a
# stronger classification cannot be quietly replaced by a weaker one.
REVISABLE_STRENGTHS = frozenset({STRENGTH_SOFT, STRENGTH_NONE})

# WHO decided, which is a different question from how much weight the decision
# carries. A deterministic rule can be hard or soft; a person's correction is
# always learned. Both are recorded, because a reviewer asking "can I trust this
# category" needs the source, and a later stage asking "may I revise it" needs
# the strength.
SOURCE_DETERMINISTIC = "deterministic"
SOURCE_LEARNED_RULE = "learned_rule"
SOURCE_AI = "ai"
SOURCE_MANUAL = "manual"
SOURCE_UNRESOLVED = "unresolved"

_SOURCE_FOR_STRENGTH = {
    STRENGTH_HARD: SOURCE_DETERMINISTIC,
    STRENGTH_SOFT: SOURCE_DETERMINISTIC,
    STRENGTH_LEARNED: SOURCE_LEARNED_RULE,
    STRENGTH_NONE: SOURCE_UNRESOLVED,
}


# VAT is where a wrong answer costs money, so the claim status is a closed set.
# Recognising a merchant proves nothing about whether input VAT is claimable,
# whether a valid tax invoice exists, or whether the purpose was business.
VAT_CLAIM_STATUSES = frozenset({"Output", "Output/Review", "Input/Review", "Input", "Review", "No"})


def is_valid_ai_account(account: str) -> bool:
    """True for any category in the shared vocabulary, canonical or historical.

    This was a hand-maintained frozenset of the professional chart, which was one
    of four vocabularies that had drifted apart. It now defers to the one
    canonical list, so a category the reviewer can select is a category the model
    may return, and vice versa.

    Historical spellings are accepted because the model is shown existing
    classifications as context and may echo one back; the caller canonicalises
    before storing, so an alias never becomes a new stored value.
    """
    return is_known_category(account)


def is_valid_vat_claim_status(status: str) -> bool:
    return status in VAT_CLAIM_STATUSES


# Keyword matching that respects word boundaries.
#
# The rule tables were plain `needle in text` substring tests, so a needle
# matched inside an unrelated word:
#
#   "PAYEE TRANSFER"        -> SARS / Tax Suspense   via "paye"
#   "LOANED EQUIPMENT HIRE" -> Loan / Liability      via "loan"
#
# Both are wrong, and wrong in the quiet way: a plausible category on a real
# transaction, at a confidence that reads as settled.
#
# A needle is boundary-matched by default, which is right for single words and
# for phrases alike ("service fee" still matches "MONTHLY SERVICE FEE"). Guards
# are only applied at an alphanumeric edge, so needles that begin or end with
# punctuation — "#service fees", "gp hea-", "paygate*dhl" — keep working.
#
# A few needles are not whole words at all, and are given their pattern outright
# rather than inferred. The invoice needles want the "INV" that begins a
# reference like "INV109034" — but as a bare prefix "inv" also matches
# "INVENTORY", so the pattern requires the digits or dash that make it a
# reference. Listing these explicitly is the point: guessing which needles meant
# something other than a word is what this change removes.
KEYWORD_PATTERN_OVERRIDES = {
    "inv": r"(?<![0-9a-z])inv[0-9-]",
    "inv0": r"(?<![0-9a-z])inv[0-9-]",
    "inv1": r"(?<![0-9a-z])inv[0-9-]",
    "inv-": r"(?<![0-9a-z])inv[0-9-]",
}


@lru_cache(maxsize=2048)
def _keyword_pattern(needle: str) -> re.Pattern[str]:
    core = needle.strip()
    override = KEYWORD_PATTERN_OVERRIDES.get(core)
    if override:
        return re.compile(override)
    left = r"(?<![0-9a-z])" if core[:1].isalnum() else ""
    right = r"(?![0-9a-z])" if core[-1:].isalnum() else ""
    return re.compile(left + re.escape(core) + right)


def keyword_matches(text: str, needle: str) -> bool:
    """True when `needle` occurs in `text` as a whole word or phrase.

    `text` is expected lowercased, as every call site already does.
    """
    core = needle.strip()
    if not core:
        return False
    return _keyword_pattern(core).search(text) is not None


def any_keyword_matches(text: str, needles: Iterable[str]) -> bool:
    return any(keyword_matches(text, needle) for needle in needles)


def source_for_strength(strength: str) -> str:
    """The source implied by a rule's standing.

    `none` maps to `unresolved` rather than `deterministic`: no rule decided
    anything, and recording the fallback as a deterministic classification would
    present "we do not know" as an answer — which is how 434 rows of a real
    statement came to be displayed as confidently classified.
    """
    return _SOURCE_FOR_STRENGTH.get(strength, SOURCE_UNRESOLVED)


@dataclass(frozen=True)
class Classification:
    """A classification and the standing of the rule that produced it."""

    category: str
    vat_treatment: str
    bank_charge: bool
    confidence: float
    strength: str
    reason: str

    @property
    def is_revisable(self) -> bool:
        return self.strength in REVISABLE_STRENGTHS

# Unambiguous bank fees. Each of these names a service only a bank performs on
# your account, so no further context is needed.
#
# Observed on Standard Bank:  SERVICE FEE, OVERDRAFT SERVICE FEE, HONOURING FEE,
#   NOTIFICATION FEE: MYUPDATES FOR BUSINESS, FEE: UNUSED FACILITY,
#   FEE: PAYMENT CONFIRM - EMAIL, FEE: REVIEW EXTENSION, FEE IMMEDIATE PAYMENT,
#   FEE - INSTANT MONEY
# Observed on FNB:  #Service Fees, #Monthly Account Fee, #Excess Item Fee,
#   Accrued bank charges
_BANK_FEE = re.compile(
    r"\b(?:"
    r"bank\s+(?:charge|charges|fee|fees)"
    r"|accrued\s+bank\s+charge"
    r"|service\s+fee"
    r"|monthly\s+account\s+fee"
    r"|account\s+fee"
    r"|transaction\s+fee"
    r"|admin(?:istration)?\s+fee"
    r"|card\s+fee"
    r"|pos\s+fee"
    r"|cash\s+(?:deposit|handling)\s+fee"
    r"|honouring\s+fee"
    r"|dishonour(?:ed)?\s+fee"
    r"|unpaid\s+item"
    r"|excess\s+(?:item\s+)?fee"
    r"|declined\s+fee"
    r"|penalty\s+fee"
    r"|overdraft\s+(?:service\s+)?fee"
    r"|unused\s+facility"
    r"|notification\s+fee"
    r"|immediate\s+payment\s+fee"
    r"|fee\s+immediate\s+payment"
    r"|ledger\s+fee"
    r"|maintenance\s+fee"
    r"|statement\s+fee"
    r"|atm\s+(?:withdrawal\s+)?fee"
    r"|withdrawal\s+fee"
    r"|balance\s+enquiry\s+fee"
    r"|payment\s+confirm"
    r")\b",
    re.IGNORECASE,
)

# Standard Bank prints many of its charges as "<payee or reference> FEE: <what
# the fee was for>" — "PRELLER TRUST FEE: PAYMENT CONFIRM - EMAIL",
# "301981485 10H00 FEE - INSTANT MONEY". The "FEE:" / "FEE -" marker is the
# bank speaking about its own charge, not a fee charged by the named party.
_FEE_MARKER = re.compile(r"\bfee\s*[:\-]\s*\S", re.IGNORECASE)

# FNB marks its own fee rows with a leading "#".
_FNB_FEE_ROW = re.compile(r"^\s*#\s*\w")

# Fee wording that is genuinely ambiguous outside a bank context. A managing
# agent charges a "monthly management fee" too. These only count when the
# description also carries bank-account context, which is how the banks print
# them: "ACC 301981485 MONTHLY MANAGEMENT FEE".
_AMBIGUOUS_FEE = re.compile(
    r"\b(?:monthly\s+management\s+fee|management\s+fee|monthly\s+fee|monthly\s+service\s+fee)\b",
    re.IGNORECASE,
)
_BANK_ACCOUNT_CONTEXT = re.compile(r"(?:\bacc\b|\baccount\b|\a/c\b|\bo/d\b|\boverdraft\b|\b\d{7,}\b)", re.IGNORECASE)


def bank_charge_evidence(description: str) -> str | None:
    """Name the evidence that this is a charge imposed by the bank, or None.

    Returning the marker rather than a boolean keeps the decision explainable:
    the reason a row was booked to Bank Charges can be shown to a reviewer.
    """
    text = (description or "").strip()
    if not text:
        return None

    if _FNB_FEE_ROW.match(text):
        return "fnb_fee_row_marker"
    match = _BANK_FEE.search(text)
    if match:
        return f"bank_fee_term:{match.group(0).strip().lower()}"
    if _FEE_MARKER.search(text):
        return "bank_fee_marker"
    if _AMBIGUOUS_FEE.search(text) and _BANK_ACCOUNT_CONTEXT.search(text):
        return "fee_term_in_account_context"
    return None


# Positive evidence of an owner / member / director withdrawal. Explicit
# terminology only — this is the whole point: no inference from "unknown payee",
# "is a debit", "low confidence" or "nothing else matched".
_DRAWINGS_TERMS = re.compile(
    r"\b(?:"
    r"drawing|drawings"
    r"|owner\s+(?:draw|drawing|withdrawal)"
    r"|director(?:'?s)?\s+(?:loan|draw|drawings|withdrawal)"
    r"|member(?:'?s)?\s+(?:loan|draw|drawings|withdrawal)"
    r"|shareholder\s+(?:loan|draw|drawings)"
    r"|personal\s+(?:draw|drawings|withdrawal)"
    r"|loan\s+account\s*[-:]?\s*(?:director|member|owner)"
    r")\b",
    re.IGNORECASE,
)


def owner_drawings_evidence(description: str) -> str | None:
    """Name the evidence that this is an owner withdrawal, or None.

    Absence of evidence is not evidence of drawings. A payment to an
    unrecognised person is unresolved, and unresolved is a review outcome —
    booking it to the owner's loan account misstates both the expense and the
    owner's position, and it is the harder error to spot afterwards.
    """
    text = (description or "").strip()
    if not text:
        return None
    match = _DRAWINGS_TERMS.search(text)
    return f"drawings_term:{match.group(0).strip().lower()}" if match else None
