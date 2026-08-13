import type { Metadata } from "next";
import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

export const metadata: Metadata = { title: "Audit Tools" };

export default function AuditToolsPage() {
  return <AccountingIntelligence module="audit-tools" />;
}
