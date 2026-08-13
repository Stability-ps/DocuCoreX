/**
 * The chart of accounts, read from the database.
 *
 * Until Stage 3 the chart was a hardcoded 28-entry array in model.ts: the same
 * for every company, uneditable, with no hierarchy, no VAT default and no
 * financial-statement mapping. It now lives in `accounting_accounts`, one chart
 * per entity, seeded from that same array so nothing about existing reports
 * changed when it moved.
 *
 * model.ts keeps its CHART for now. It is what the current export path reports
 * against, and repointing that at the database is Stage 5's job — the stage that
 * makes the ledger authoritative. A test asserts the two stay identical until
 * then, so this move cannot quietly become a change of meaning.
 */

export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "income"
  | "cost_of_sales"
  | "expense"
  | "other_income"
  | "other_expense"
  | "taxation";

export type NormalBalance = "debit" | "credit";

export type LedgerAccount = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  parentId: string | null;
  isActive: boolean;
  isSystem: boolean;
  vatDefault: string | null;
  description: string | null;
};

export type AccountingEntity = {
  id: string;
  name: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  isDefault: boolean;
  baseCurrency: string;
  reportingFramework: string | null;
  financialYearEndMonth: number;
  financialYearEndDay: number;
};

/** The order accountants expect a chart to be presented in. */
export const ACCOUNT_TYPE_ORDER: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "cost_of_sales",
  "expense",
  "other_income",
  "other_expense",
  "taxation",
];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  cost_of_sales: "Cost of Sales",
  expense: "Operating Expenses",
  other_income: "Other Income",
  other_expense: "Other Expenses",
  taxation: "Taxation",
};
