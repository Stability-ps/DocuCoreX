from __future__ import annotations

from .profiles import FNB_PARSER, PARSER_SCAFFOLDS
from .registry import BankRegistry


def register_default_parsers() -> None:
    BankRegistry.register(FNB_PARSER)
    for parser in PARSER_SCAFFOLDS:
        BankRegistry.register(parser)
