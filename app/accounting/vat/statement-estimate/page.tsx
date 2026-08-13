import type { Metadata } from "next";
import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

export const metadata: Metadata = { title: "VAT estimated from statements" };

// The pre-ledger VAT analysis, kept working rather than removed. It estimates
// VAT at 15/115 over extracted bank-statement amounts, which is a useful working
// paper over source data and is NOT an accounting record — /accounting/vat is.
export default function StatementVatPage() {
  return <AccountingIntelligence module="tax-vat" />;
}
