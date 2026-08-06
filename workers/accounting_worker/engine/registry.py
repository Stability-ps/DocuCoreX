from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ParserCapabilities:
    ocr_required: bool
    supports_multi_page: bool
    supports_combined_statements: bool
    running_balance_validation: bool
    vat_extraction: bool
    ai_categorisation: bool
    review_mode: bool
    bank_charges_detection: bool


@dataclass(frozen=True)
class ParserProfile:
    id: str
    bank_name: str
    version: str
    statement_type: str
    capabilities: ParserCapabilities


class BankParser(Protocol):
    profile: ParserProfile


class BankRegistry:
    """A catalogue of bank profiles and their capabilities.

    This registry no longer decides which parser reads a statement. It used to,
    via a `detect(text_sample, file_name)` that matched keywords against the two
    concatenated — and since every accounting upload is stored under
    ".../accounting/fnb/...", the literal "fnb" in that path matched the FNB
    parser for every document ever uploaded, so the statement's own text was
    never reached. When nothing matched it returned `_parsers[0]`, FNB again.

    Detection now lives in engine/detection.py, reads statement text only, and
    can return `unknown`.
    """

    _parsers: list[BankParser] = []

    @classmethod
    def register(cls, parser: BankParser) -> None:
        if not any(existing.profile.id == parser.profile.id for existing in cls._parsers):
            cls._parsers.append(parser)

    @classmethod
    def all(cls) -> list[BankParser]:
        return list(cls._parsers)

    @classmethod
    def get(cls, profile_id: str) -> BankParser | None:
        return next((parser for parser in cls._parsers if parser.profile.id == profile_id), None)
