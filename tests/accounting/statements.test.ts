import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Load the "@/..." path alias so we can import the real accounting logic.
register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { computeProfitLoss, accountType } = await import("@/lib/accounting/analytics.ts");
const { buildExportSections, buildStatementMetadata, resolveCompanyName } = await import("@/lib/accounting/export.ts");

function txn(o: Record<string, unknown>) {
  return {
    id: String(o.id),
    runId: "r1",
    workspaceId: "w1",
    transactionDate: o.d ?? "2026-03-10",
    description: String(o.desc ?? ""),
    debitAmount: (o.debit as number) ?? null,
    creditAmount: (o.credit as number) ?? null,
    runningBalance: 0,
    bankCharge: Boolean(o.bankCharge),
    accountCategory: String(o.cat ?? "Uncategorised"),
    vatTreatment: (o.vat as string) ?? "review",
    supportedByInvoice: false,
    notes: "",
    confidence: (o.conf as number) ?? 90,
    reviewStatus: (o.review as string) ?? "needs_review",
    sourcePage: 1,
    rawText: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

// Mirrors the ACAPOLITE-style problems reported in the workbook.
const txns = [
  txn({ id: "1", desc: "FNB OB Pmt From Client", credit: 100000, cat: "Sales / Revenue", vat: "review" }),
  txn({ id: "2", desc: "Tax Deposit", credit: 120000, cat: "SARS / Tax Suspense", vat: "review" }),
  txn({ id: "3", desc: "ADT Cash Deposit Woodland", credit: 23550, cat: "Cash Deposits / Revenue", vat: "review" }),
  txn({ id: "4", desc: "Refund", debit: 35000, cat: "Refund / Suspense", vat: "review" }),
  txn({ id: "5", desc: "Loan", debit: 500, cat: "Loan / Liability", vat: "out_of_scope" }),
  txn({ id: "6", desc: "FNB App Rtc Pmt To Patric", debit: 25000, cat: "Director Loan / Drawings", vat: "out_of_scope" }),
  txn({ id: "7", desc: "# Service Fees", debit: 616.8, cat: "Bank Charges", vat: "standard", bankCharge: true }),
  txn({ id: "8", desc: "Motor fuel", debit: 1000, cat: "Motor Vehicle Expenses", vat: "standard" }),
];
const opening = 5000;
const totalCredits = 100000 + 120000 + 23550;
const totalDebits = 35000 + 500 + 25000 + 616.8 + 1000;
const closing = opening + totalCredits - totalDebits;
const run = {
  id: "run-1234abcd",
  workspaceId: "w1",
  documentId: "d1",
  processingJobId: null,
  bank: "FNB",
  statementType: "bank_statement",
  status: "completed",
  companyName: "ACAPOLITE CONSULTING (PTY) LTD",
  accountNumber: "63041819765",
  statementPeriodStart: "2026-03-01",
  statementPeriodEnd: "2026-03-31",
  openingBalance: opening,
  closingBalance: closing,
  transactionCount: txns.length,
  bankChargesTotal: 616.8,
  sourceStoragePath: "x",
  workbookStoragePath: null,
  extractionProvider: "python",
  confidence: 96,
  error: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const detail = { run, transactions: txns };

test("account type taxonomy routes non-P&L categories correctly", () => {
  assert.equal(accountType("SARS / Tax Suspense"), "tax");
  assert.equal(accountType("Refund / Suspense"), "refund");
  assert.equal(accountType("Loan / Liability"), "loan");
  assert.equal(accountType("Director Loan / Drawings"), "director_loan");
  assert.equal(accountType("Bank Charges"), "bank_charges");
  assert.equal(accountType("Sales / Revenue"), "revenue");
  assert.equal(accountType("Inter-account Transfer"), "transfer");
});

test("P&L excludes tax, refund, loan and director from revenue/expenses", () => {
  const pl = computeProfitLoss(txns, run);
  const revenueCats = pl.revenue.map((r) => r.category);
  const expenseCats = pl.expenses.map((e) => e.category);
  assert.ok(!revenueCats.includes("SARS / Tax Suspense"), "tax must not be revenue");
  assert.ok(!expenseCats.includes("Refund / Suspense"), "refund must not be an expense");
  assert.ok(!expenseCats.includes("Loan / Liability"), "loan must not be an expense");
  assert.ok(!expenseCats.includes("Director Loan / Drawings"), "director loan must not be an expense");
  // They must be surfaced as excluded instead.
  const excludedCats = pl.excluded.map((e) => e.category);
  for (const c of ["SARS / Tax Suspense", "Refund / Suspense", "Loan / Liability", "Director Loan / Drawings"]) {
    assert.ok(excludedCats.includes(c), `${c} must be shown as excluded`);
  }
  // Revenue is only real revenue; expenses only real expenses + bank charges.
  assert.equal(pl.totalRevenue, 100000 + 23550);
  assert.equal(Math.round(pl.totalExpenses * 100) / 100, 616.8 + 1000);
});

function cellText(cell: unknown): string {
  const v = (cell as { v?: unknown })?.v;
  return v === undefined ? "" : String(v);
}

test("General Ledger is not one collapsed suspense line", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const gl = sections.find((s: { id: string }) => s.id === "general-ledger");
  const accountNames = gl.rows.slice(1, -1).map((r: unknown[]) => cellText(r[0]));
  assert.ok(accountNames.length > 1, "GL must have multiple accounts");
  assert.ok(accountNames.includes("Bank Charges"), "GL must contain a Bank Charges account");
  assert.ok(accountNames.includes("Sales / Revenue"), "GL must contain a revenue account");
  // Bank Charges GL debit must be the fee (616.80), never a cash deposit (23,550).
  const bankRow = gl.rows.find((r: unknown[]) => cellText(r[0]) === "Bank Charges");
  const bankDebit = Number((bankRow[2] as { v: number }).v);
  assert.equal(bankDebit, 616.8, "bank charges must be the fee, not a deposit");
  assert.notEqual(bankDebit, 23550);
});

test("Trial Balance balances via a bank contra", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const tb = sections.find((s: { id: string }) => s.id === "trial-balance");
  const balancedRow = tb.rows.find((r: unknown[]) => cellText(r[0]) === "Balanced");
  assert.equal(cellText(balancedRow[1]), "Yes", "trial balance must balance");
  const hasContra = tb.rows.some((r: unknown[]) => cellText(r[0]) === "Bank / Cash (contra)");
  assert.ok(hasContra, "trial balance must include a bank contra account");
});

test("Cash Flow reconciles opening to closing and separates activities", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const cf = sections.find((s: { id: string }) => s.id === "cash-flow");
  const reconRow = cf.rows.find((r: unknown[]) => cellText(r[0]) === "Reconciled");
  assert.match(cellText(reconRow[1]), /^Yes/, "cash flow must reconcile to the bank balance");
  const activities = cf.rows.map((r: unknown[]) => cellText(r[0]));
  assert.ok(activities.some((a) => a.includes("Tax / SARS")), "cash flow must separate tax movements");
  assert.ok(activities.some((a) => a.includes("Owner / director")), "cash flow must separate owner movements");
});

test("Balance Sheet shows detected movements, not fabricated assets", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const bs = sections.find((s: { id: string }) => s.id === "balance-sheet");
  const text = bs.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  assert.match(text, /Cash at bank/);
  assert.match(text, /Tax \/ SARS suspense movement/);
  assert.match(text, /No figures are fabricated/);
});

test("statement metadata is canonical and reconciles", () => {
  const meta = buildStatementMetadata(detail, resolveCompanyName(run.companyName, null));
  assert.equal(meta.company, "ACAPOLITE CONSULTING (PTY) LTD");
  assert.equal(meta.accountNumber, "63041819765");
  assert.equal(meta.reconciled, true);
});
