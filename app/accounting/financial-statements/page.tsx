import type { Metadata } from "next";
import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

export const metadata: Metadata = { title: "Financial Statements" };

export default function FinancialStatementsPage() {
  return <AccountingIntelligence module="financial-statements" />;
}
