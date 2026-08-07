import { BANK_PARSER_PROFILES } from "@/lib/accounting/engine/profiles";

/**
 * The parser catalogue. It no longer decides which parser reads a statement.
 *
 * It used to, through a `detectBankProfile({ bank, fileName })` that matched
 * keywords against a bank label and a file name and fell back to FNB. Both
 * inputs were unsound: the bank was hardcoded to "FNB South Africa" at upload,
 * and the file name was a storage path that always contained "/accounting/fnb/".
 * It returned `fnb_business_v1` for every statement, whatever the bank, and
 * Standard Bank statements died in the FNB parser.
 *
 * Detection now lives in `@/lib/accounting/engine/bank-detection`, scores
 * statement text only, and can return `unknown`.
 */
export function listRegisteredParsers() {
  return BANK_PARSER_PROFILES;
}
