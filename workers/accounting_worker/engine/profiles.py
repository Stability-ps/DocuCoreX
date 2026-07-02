from __future__ import annotations

from dataclasses import dataclass

from .registry import BankParser, ParserCapabilities, ParserProfile


@dataclass(frozen=True)
class KeywordBankParser(BankParser):
    profile: ParserProfile
    keywords: tuple[str, ...]

    def matches(self, text_sample: str, file_name: str) -> bool:
        haystack = f"{text_sample} {file_name}"
        return any(keyword in haystack for keyword in self.keywords)


FNB_PARSER = KeywordBankParser(
    profile=ParserProfile(
        id="fnb_business_v1",
        bank_name="FNB South Africa",
        version="fnb_business_v1",
        statement_type="business_bank_statement",
        capabilities=ParserCapabilities(
            ocr_required=True,
            supports_multi_page=True,
            supports_combined_statements=True,
            running_balance_validation=True,
            vat_extraction=True,
            ai_categorisation=True,
            review_mode=True,
            bank_charges_detection=True,
        ),
    ),
    keywords=("fnb", "first national bank", "platinum business account"),
)

PARSER_SCAFFOLDS = [
    KeywordBankParser(
        profile=ParserProfile(
            id="standard_bank_business_v1",
            bank_name="Standard Bank",
            version="standard_bank_business_v1",
            statement_type="business_bank_statement",
            capabilities=ParserCapabilities(
                ocr_required=True,
                supports_multi_page=True,
                supports_combined_statements=False,
                running_balance_validation=False,
                vat_extraction=False,
                ai_categorisation=False,
                review_mode=True,
                bank_charges_detection=False,
            ),
        ),
        keywords=("standard bank",),
    ),
    KeywordBankParser(
        profile=ParserProfile(
            id="absa_business_v1",
            bank_name="ABSA",
            version="absa_business_v1",
            statement_type="business_bank_statement",
            capabilities=ParserCapabilities(
                ocr_required=True,
                supports_multi_page=True,
                supports_combined_statements=False,
                running_balance_validation=False,
                vat_extraction=False,
                ai_categorisation=False,
                review_mode=True,
                bank_charges_detection=False,
            ),
        ),
        keywords=("absa",),
    ),
    KeywordBankParser(
        profile=ParserProfile(
            id="nedbank_business_v1",
            bank_name="Nedbank",
            version="nedbank_business_v1",
            statement_type="business_bank_statement",
            capabilities=ParserCapabilities(
                ocr_required=True,
                supports_multi_page=True,
                supports_combined_statements=False,
                running_balance_validation=False,
                vat_extraction=False,
                ai_categorisation=False,
                review_mode=True,
                bank_charges_detection=False,
            ),
        ),
        keywords=("nedbank",),
    ),
    KeywordBankParser(
        profile=ParserProfile(
            id="capitec_business_v1",
            bank_name="Capitec",
            version="capitec_business_v1",
            statement_type="business_bank_statement",
            capabilities=ParserCapabilities(
                ocr_required=True,
                supports_multi_page=True,
                supports_combined_statements=False,
                running_balance_validation=False,
                vat_extraction=False,
                ai_categorisation=False,
                review_mode=True,
                bank_charges_detection=False,
            ),
        ),
        keywords=("capitec",),
    ),
    KeywordBankParser(
        profile=ParserProfile(
            id="investec_business_v1",
            bank_name="Investec",
            version="investec_business_v1",
            statement_type="business_bank_statement",
            capabilities=ParserCapabilities(
                ocr_required=True,
                supports_multi_page=True,
                supports_combined_statements=False,
                running_balance_validation=False,
                vat_extraction=False,
                ai_categorisation=False,
                review_mode=True,
                bank_charges_detection=False,
            ),
        ),
        keywords=("investec",),
    ),
]
