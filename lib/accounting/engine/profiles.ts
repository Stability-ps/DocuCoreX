import type { BankCapability, BankProfileId, ParserCapabilityMatrix } from "@/lib/accounting/engine/types";

export type BankParserProfile = {
  id: BankProfileId;
  bankName: string;
  statementType: string;
  parserVersion: string;
  capabilities: ParserCapabilityMatrix;
};

const enabledCapabilities = (items: BankCapability[]): ParserCapabilityMatrix => {
  const set = new Set(items);
  return {
    ocr_required: set.has("ocr_required"),
    supports_multi_page: set.has("supports_multi_page"),
    supports_combined_statements: set.has("supports_combined_statements"),
    running_balance_validation: set.has("running_balance_validation"),
    vat_extraction: set.has("vat_extraction"),
    ai_categorisation: set.has("ai_categorisation"),
    review_mode: set.has("review_mode"),
    bank_charges_detection: set.has("bank_charges_detection"),
  };
};

export const BANK_PARSER_PROFILES: BankParserProfile[] = [
  {
    id: "fnb_business_v1",
    bankName: "FNB South Africa",
    statementType: "business_bank_statement",
    parserVersion: "fnb_business_v1",
    capabilities: enabledCapabilities([
      "ocr_required",
      "supports_multi_page",
      "supports_combined_statements",
      "running_balance_validation",
      "vat_extraction",
      "ai_categorisation",
      "review_mode",
      "bank_charges_detection",
    ]),
  },
  {
    id: "standard_bank_business_v1",
    bankName: "Standard Bank",
    statementType: "business_bank_statement",
    parserVersion: "standard_bank_business_v1",
    capabilities: enabledCapabilities(["ocr_required", "supports_multi_page", "review_mode"]),
  },
  {
    id: "absa_business_v1",
    bankName: "ABSA",
    statementType: "business_bank_statement",
    parserVersion: "absa_business_v1",
    capabilities: enabledCapabilities(["ocr_required", "supports_multi_page", "review_mode"]),
  },
  {
    id: "nedbank_business_v1",
    bankName: "Nedbank",
    statementType: "business_bank_statement",
    parserVersion: "nedbank_business_v1",
    capabilities: enabledCapabilities(["ocr_required", "supports_multi_page", "review_mode"]),
  },
  {
    id: "capitec_business_v1",
    bankName: "Capitec",
    statementType: "business_bank_statement",
    parserVersion: "capitec_business_v1",
    capabilities: enabledCapabilities(["ocr_required", "supports_multi_page", "review_mode"]),
  },
  {
    id: "investec_business_v1",
    bankName: "Investec",
    statementType: "business_bank_statement",
    parserVersion: "investec_business_v1",
    capabilities: enabledCapabilities(["ocr_required", "supports_multi_page", "review_mode"]),
  },
];

export function getParserProfileById(id: BankProfileId) {
  return BANK_PARSER_PROFILES.find((profile) => profile.id === id) ?? null;
}
