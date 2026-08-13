import type { Metadata } from "next";
import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

export const metadata: Metadata = { title: "Forecasting" };

export default function ForecastingPage() {
  return <AccountingIntelligence module="forecasting" />;
}
