import type { Metadata } from "next";
import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

export const metadata: Metadata = { title: "VAT" };

export default function VatPage() {
  return <AccountingIntelligence module="tax-vat" />;
}
