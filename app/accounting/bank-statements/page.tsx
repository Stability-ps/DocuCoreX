import type { Metadata } from "next";
import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

export const metadata: Metadata = { title: "Bank Statements" };

export default function BankStatementsPage() {
  return <AccountingIntelligence module="bank-statements" />;
}
