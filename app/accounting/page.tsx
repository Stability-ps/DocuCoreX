import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";

// No PageHeader. This is an application workspace, not a landing page, and the
// marketing-style block here ("Accounting workspace for finance teams") sat
// directly above the component's own "Accounting Intelligence › Bank Statements"
// breadcrumb — two headers, one of them selling the product to someone already
// inside it. The component owns its header.
export default function AccountingPage() {
  return <AccountingIntelligence />;
}
