"""Evidence-based bank detection.

Detection reads the STATEMENT TEXT and nothing else. It deliberately never sees
the file name or the storage path.

Why that matters: every accounting upload is stored under a path built by
`accountingStoragePath()` in lib/accounting/server.ts as

    {workspaceId}/accounting/fnb/{uuid}-{fileName}

The previous detector (`BankRegistry.detect`) folded the storage path into the
keyword haystack, so the literal "fnb" in that path matched the FNB parser's
"fnb" keyword for EVERY document ever uploaded. FNB is registered first, so it
always won and the document's own text was never reached — a Standard Bank
statement was routed into the FNB parser and failed with "No FNB transactions
could be parsed from this PDF."

Scoring model
-------------
Each bank has weighted markers. A marker found in the statement HEADER (the
first HEADER_CHARS characters — the letterhead, where a bank identifies itself)
counts double; the same marker further down the document is more likely to be a
counterparty named in a transaction description ("STANDARD BANK TRANSFER" on an
FNB statement), so it counts single.

A detection is only returned when the winner clears MIN_SCORE and beats the
runner-up by MARGIN. Anything else is `unknown` — never a default bank.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Iterable

UNKNOWN_PROFILE_ID = "unknown"
UNKNOWN_BANK_NAME = "Unknown"

# The letterhead. Long enough to cover a first page of any of the six layouts,
# short enough that page 2+ transaction descriptions do not leak into it.
HEADER_CHARS = 3000

# A single brand marker in the BODY alone (weight 5) deliberately does not
# clear this: that is the "counterparty named in a description" case. A brand
# marker in the header (5 x 2 = 10) does, and so does brand + domain in the
# body (5 + 5 = 10) — a competitor's URL is not printed in a description.
MIN_SCORE = 6

# The winner must be this far ahead of the runner-up. Two banks within MARGIN
# of each other means the evidence does not identify the statement.
MARGIN = 4


@dataclass(frozen=True)
class BankMarker:
    pattern: str
    weight: int
    label: str


@dataclass(frozen=True)
class BankFingerprint:
    profile_id: str
    bank_name: str
    markers: tuple[BankMarker, ...]


@dataclass(frozen=True)
class BankDetection:
    """The outcome of detection. `profile_id` is UNKNOWN_PROFILE_ID when the
    evidence does not identify a supported bank — it is never a fallback bank."""

    profile_id: str
    bank_name: str
    confidence: float
    reason: str
    evidence: tuple[str, ...] = ()
    scores: dict[str, int] = field(default_factory=dict)

    @property
    def is_known(self) -> bool:
        return self.profile_id != UNKNOWN_PROFILE_ID


BANK_FINGERPRINTS: tuple[BankFingerprint, ...] = (
    BankFingerprint(
        profile_id="fnb_business_v1",
        bank_name="FNB South Africa",
        markers=(
            BankMarker(r"\bfirst national bank\b", 5, "first national bank"),
            BankMarker(r"\bfnb\b", 5, "fnb"),
            BankMarker(r"\bfnb\.co\.za\b", 5, "fnb.co.za"),
            BankMarker(r"\bfirstrand bank\b", 4, "firstrand bank"),
            BankMarker(r"\bplatinum business account\b", 3, "platinum business account"),
            BankMarker(r"\btransactions in rand\b", 3, "fnb transaction section heading"),
        ),
    ),
    BankFingerprint(
        profile_id="standard_bank_business_v1",
        bank_name="Standard Bank",
        markers=(
            BankMarker(r"\bstandard bank\b", 5, "standard bank"),
            BankMarker(r"\bstandardbank\.co\.za\b", 5, "standardbank.co.za"),
            BankMarker(r"\bstandard bank of south africa\b", 3, "standard bank of south africa"),
        ),
    ),
    BankFingerprint(
        profile_id="absa_business_v1",
        bank_name="ABSA",
        markers=(
            BankMarker(r"\babsa\b", 5, "absa"),
            BankMarker(r"\babsa\.co\.za\b", 5, "absa.co.za"),
            BankMarker(r"\babsa bank limited\b", 3, "absa bank limited"),
        ),
    ),
    BankFingerprint(
        profile_id="nedbank_business_v1",
        bank_name="Nedbank",
        markers=(
            BankMarker(r"\bnedbank\b", 5, "nedbank"),
            BankMarker(r"\bnedbank\.co\.za\b", 5, "nedbank.co.za"),
            BankMarker(r"\bnedbank limited\b", 3, "nedbank limited"),
        ),
    ),
    BankFingerprint(
        profile_id="capitec_business_v1",
        bank_name="Capitec",
        markers=(
            BankMarker(r"\bcapitec\b", 5, "capitec"),
            BankMarker(r"\bcapitecbank\.co\.za\b", 5, "capitecbank.co.za"),
            BankMarker(r"\bcapitec bank limited\b", 3, "capitec bank limited"),
        ),
    ),
    BankFingerprint(
        profile_id="investec_business_v1",
        bank_name="Investec",
        markers=(
            BankMarker(r"\binvestec\b", 5, "investec"),
            BankMarker(r"\binvestec\.co\.za\b", 5, "investec.co.za"),
            BankMarker(r"\binvestec bank limited\b", 3, "investec bank limited"),
        ),
    ),
)


def normalise_statement_text(text: str) -> str:
    """Lowercase and collapse whitespace so markers match across layouts.

    OCR and PDF extraction break a letterhead across lines and pad it with
    non-breaking spaces; "STANDARD\\n  BANK" and "STANDARD BANK" must score the
    same.
    """
    return re.sub(r"\s+", " ", (text or "").replace("\u00a0", " ")).strip().lower()


def _score_fingerprint(
    fingerprint: BankFingerprint,
    haystack: str,
    header: str,
) -> tuple[int, list[str]]:
    score = 0
    evidence: list[str] = []
    for marker in fingerprint.markers:
        if not re.search(marker.pattern, haystack):
            continue
        in_header = bool(re.search(marker.pattern, header))
        score += marker.weight * 2 if in_header else marker.weight
        evidence.append(f"{marker.label} (header)" if in_header else marker.label)
    return score, evidence


def _confidence(best: int, runner_up: int) -> float:
    """Share of the total evidence held by the winner, mapped onto 55..99.

    Unopposed evidence scores 99 (never 100 — detection is evidence, not proof).
    A dead heat would score 55, but a dead heat cannot reach here: it fails the
    MARGIN test and returns `unknown` with confidence 0.
    """
    total = best + runner_up
    if total <= 0:
        return 0.0
    share = best / total
    value = min(99.0, 55.0 + 88.0 * (share - 0.5))
    # Half-up, not Python's default half-even, so the TypeScript mirror in
    # lib/accounting/engine/bank-detection.ts produces the identical number.
    return math.floor(value * 100 + 0.5) / 100


def _unknown(reason: str, scores: dict[str, int]) -> BankDetection:
    return BankDetection(
        profile_id=UNKNOWN_PROFILE_ID,
        bank_name=UNKNOWN_BANK_NAME,
        confidence=0.0,
        reason=reason,
        evidence=(),
        scores=scores,
    )


def detect_bank(text: str, fingerprints: Iterable[BankFingerprint] | None = None) -> BankDetection:
    """Identify the issuing bank from statement text alone.

    Returns a detection whose `profile_id` is UNKNOWN_PROFILE_ID when the
    evidence is absent or ambiguous. There is no default bank: routing an
    unidentified statement to a bank-specific parser is exactly the defect this
    module exists to remove.
    """
    haystack = normalise_statement_text(text)
    if not haystack:
        return _unknown("no_text", {})

    header = haystack[:HEADER_CHARS]
    scores: dict[str, int] = {}
    evidence_by_profile: dict[str, list[str]] = {}

    for fingerprint in fingerprints or BANK_FINGERPRINTS:
        score, evidence = _score_fingerprint(fingerprint, haystack, header)
        if score > 0:
            scores[fingerprint.profile_id] = score
            evidence_by_profile[fingerprint.profile_id] = evidence

    if not scores:
        return _unknown("no_bank_markers_found", scores)

    ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    best_profile, best_score = ranked[0]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0

    if best_score < MIN_SCORE:
        return _unknown(f"weak_evidence:{best_profile}={best_score}<{MIN_SCORE}", scores)
    if best_score - runner_up_score < MARGIN:
        return _unknown(f"ambiguous:{best_profile}={best_score},runner_up={runner_up_score}", scores)

    fingerprint = next(item for item in (fingerprints or BANK_FINGERPRINTS) if item.profile_id == best_profile)
    return BankDetection(
        profile_id=best_profile,
        bank_name=fingerprint.bank_name,
        confidence=_confidence(best_score, runner_up_score),
        reason="matched_bank_markers",
        evidence=tuple(evidence_by_profile[best_profile]),
        scores=scores,
    )
