import type { VatTreatment } from "@/lib/accounting/types";

export const ACCOUNTING_CATEGORY_OPTIONS = [
  "Income",
  "Sales / Revenue",
  "Supplier Payments",
  "Other Operating Expenses",
  "Accounting / Professional Fees",
  "Bank Charges",
  "Staff Welfare / Meals / Entertainment",
  "Software Subscriptions",
  "Software / IT",
  "Courier / Delivery",
  "Insurance",
  "Levies",
  "Salaries & Wages",
  "Inter-account Transfer",
  "Motor Vehicle Expenses",
  "Rent",
  "Utilities",
  "Repairs & Maintenance",
  "Finance Costs",
  "Loan / Liability",
  "Related Party / Drawings",
  "Tax / SARS Suspense",
  "VAT Control",
  "Suspense / Review Required",
  "Review Required",
  "Uncategorised Expense",
  "Uncategorised",
];

export const VAT_TREATMENT_OPTIONS: Array<{ value: VatTreatment; label: string }> = [
  { value: "standard", label: "Standard VAT" },
  { value: "zero_rated", label: "Zero-rated" },
  { value: "exempt", label: "Exempt" },
  { value: "out_of_scope", label: "Out of scope" },
  { value: "review", label: "Review" },
];

export function isUnresolvedAccountingCategory(category: string) {
  return /uncategori|review|required|suspense/i.test(category);
}
