import type { Metadata } from "next";
import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

export const metadata: Metadata = { title: "Transaction Insights" };

export default function TransactionInsightsPage() {
  return <AccountingIntelligence module="ai-intelligence" />;
}
