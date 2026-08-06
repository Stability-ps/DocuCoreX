import { BANK_PARSER_PROFILES } from "@/lib/accounting/engine/profiles";
import type { BankProfileId } from "@/lib/accounting/engine/types";

const bankKeywordMap: Array<{ profileId: BankProfileId; keywords: string[] }> = [
  { profileId: "fnb_business_v1", keywords: ["fnb", "first national bank"] },
  { profileId: "standard_bank_business_v1", keywords: ["standard bank"] },
  { profileId: "absa_business_v1", keywords: ["absa"] },
  { profileId: "nedbank_business_v1", keywords: ["nedbank"] },
  { profileId: "capitec_business_v1", keywords: ["capitec"] },
  { profileId: "investec_business_v1", keywords: ["investec"] },
];

/**
 * @deprecated Use `detectBankFromText` from
 * `@/lib/accounting/engine/bank-detection` instead.
 *
 * This matches on a bank label and a FILE NAME, and defaults to FNB when
 * nothing matches. Both are unsound: the two call sites pass a bank string that
 * is hardcoded to "FNB South Africa" at upload (lib/accounting/server.ts), and
 * the file-name input is a storage path that always contains "/accounting/fnb/".
 * It therefore returns `fnb_business_v1` for every statement, whatever the bank.
 *
 * Kept unchanged for now so this change is behaviour-neutral; the call sites
 * move to the evidence-based detector in the following PRs.
 */
export function detectBankProfile(input: { bank?: string | null; fileName?: string | null }) {
  const haystack = `${input.bank ?? ""} ${input.fileName ?? ""}`.toLowerCase();
  const match = bankKeywordMap.find(({ keywords }) => keywords.some((keyword) => haystack.includes(keyword)));
  return match?.profileId ?? "fnb_business_v1";
}

export function listRegisteredParsers() {
  return BANK_PARSER_PROFILES;
}
