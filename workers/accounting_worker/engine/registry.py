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

    def matches(self, text_sample: str, file_name: str) -> bool:
        ...


class BankRegistry:
    _parsers: list[BankParser] = []

    @classmethod
    def register(cls, parser: BankParser) -> None:
        if not any(existing.profile.id == parser.profile.id for existing in cls._parsers):
            cls._parsers.append(parser)

    @classmethod
    def all(cls) -> list[BankParser]:
        return list(cls._parsers)

    @classmethod
    def detect(cls, text_sample: str, file_name: str) -> BankParser | None:
        lowered_file = file_name.lower()
        lowered_text = text_sample.lower()
        for parser in cls._parsers:
            if parser.matches(lowered_text, lowered_file):
                return parser
        return cls._parsers[0] if cls._parsers else None
