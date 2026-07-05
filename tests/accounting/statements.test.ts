import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Load the "@/..." path alias so we can import the real accounting logic.
register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { computeProfitLoss, accountType } = await import("@/lib/accounting/analytics.ts");
const { buildExportSections, buildStatementMetadata, resolveCompanyName, FULL_PACK_SECTIONS, EXPORT_MENU } = await import("@/lib/accounting/export.ts");
const { buildAccountingModel, resolveAccount, CHART } = await import("@/lib/accounting/model.ts");

// The only sheet names allowed in the workbook.
const APPROVED_SHEETS = new Set([
  "Cover",
  "Summary",
  "Data Quality",
  "Extraction Log",
  "Transactions",
  "Review Queue",
  "VAT Working Paper",
  "General Ledger",
  "Trial Balance",
  "Profit & Loss",
  "Balance Sheet",
  "Cash Flow",
  "Bank Reconciliation",
  "AI Accountant Notes",
  "Audit Exceptions",
  "Assumptions",
  "Financial Ratios", // conditional (reliable only)
  "Forecasting", // conditional (3+ periods only)
]);

function packSheets(d: unknown) {
  const all = buildExportSections(d as never, "ACAPOLITE CONSULTING (PTY) LTD");
  const byId = new Map(all.map((s: { id: string }) => [s.id, s]));
  return FULL_PACK_SECTIONS.map((id: string) => byId.get(id)).filter(Boolean) as Array<{ id: string; sheet: string; rows: unknown[] }>;
}

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
  // Revenue is only confirmed sales (cash deposits are excluded pending review);
  // expenses are only real expenses + bank charges.
  assert.equal(pl.totalRevenue, 100000);
  assert.ok(excludedCats.includes("Cash Deposits / Revenue"), "cash deposits excluded from revenue");
  assert.equal(Math.round(pl.totalExpenses * 100) / 100, 616.8 + 1000);
});

function cellText(cell: unknown): string {
  const v = (cell as { v?: unknown })?.v;
  return v === undefined ? "" : String(v);
}

test("General Ledger is double-entry and not one collapsed suspense line", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const gl = sections.find((s: { id: string }) => s.id === "general-ledger");
  // Account name column is index 5 in the double-entry GL.
  const accountNames = new Set(gl.rows.slice(1, -1).map((r: unknown[]) => cellText(r[5])));
  assert.ok(accountNames.size > 1, "GL must have multiple accounts");
  assert.ok(accountNames.has("Cash at Bank"), "bank posts every leg");
  assert.ok(accountNames.has("Bank Charges"), "GL must contain a Bank Charges account");
  // The Bank Charges debit leg must be the fee (616.80), never a cash deposit (23,550).
  const bankRow = gl.rows.find((r: unknown[]) => cellText(r[5]) === "Bank Charges" && Number((r[6] as { v?: number })?.v) > 0);
  assert.equal(Number((bankRow[6] as { v: number }).v), 616.8, "bank charges must be the fee, not a deposit");
});

test("Trial Balance is double-entry balanced (no artificial contra plug)", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const tb = sections.find((s: { id: string }) => s.id === "trial-balance");
  const balancedRow = tb.rows.find((r: unknown[]) => cellText(r[0]) === "Balanced");
  assert.equal(cellText(balancedRow[1]), "Yes", "trial balance must balance");
  // Bank is a real ledger account (Cash at Bank), not a plugged "contra".
  const accountNames = tb.rows.map((r: unknown[]) => cellText(r[1]));
  assert.ok(accountNames.includes("Cash at Bank"), "bank must be a real ledger account");
  assert.ok(!accountNames.includes("Bank / Cash (contra)"), "no artificial contra plug");
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

// When extraction does NOT reconcile, TB / Cash Flow / P&L must be marked
// invalid/unreliable and the TB must not be balanced by an artificial contra.
const unbalancedRun = { ...run, closingBalance: closing + 5000 };
const unbalancedDetail = { run: unbalancedRun, transactions: txns };

test("Trial Balance is marked invalid (no artificial contra) when unreconciled", () => {
  const sections = buildExportSections(unbalancedDetail, "ACAPOLITE CONSULTING (PTY) LTD");
  const tb = sections.find((s: { id: string }) => s.id === "trial-balance");
  const text = tb.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  assert.match(text, /INVALID|Invalid/);
  assert.ok(!text.includes("Bank / Cash (contra)"), "must not hide the gap behind a contra");
  assert.ok(!/Balanced\s+Yes/.test(text), "must not claim balanced when unreconciled");
});

test("Cash Flow and P&L are watermarked unreliable when unreconciled", () => {
  const sections = buildExportSections(unbalancedDetail, "ACAPOLITE CONSULTING (PTY) LTD");
  const cf = sections.find((s: { id: string }) => s.id === "cash-flow");
  const pl = sections.find((s: { id: string }) => s.id === "profit-loss");
  const cfText = cf.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  const plText = pl.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  assert.match(cfText, /INVALID|does not tie/);
  assert.match(plText, /UNRELIABLE|does not reconcile/);
});

test("account type keeps refund and suspense distinct", () => {
  assert.equal(accountType("Refund / Suspense"), "refund");
  assert.equal(accountType("Suspense / Review Required"), "suspense");
  assert.equal(accountType("Related Party / Drawings"), "director_loan");
  assert.equal(accountType("Revenue Review"), "revenue");
});

// ─── One canonical accounting model ────────────────────────────────────────

test("every category maps to exactly one chart account with a number", () => {
  for (const cat of ["Bank Charges", "Sales / Revenue", "SARS / Tax Suspense", "Director Loan / Drawings", "Loan / Liability", "Refund / Suspense", "Suspense / Review Required", "Motor Vehicle Expenses", "Cash Deposits / Revenue"]) {
    const a = resolveAccount(cat);
    assert.ok(a && /^\d{4}$/.test(a.number), `${cat} must map to a numbered account`);
    assert.ok(CHART.some((c: { number: string }) => c.number === a.number), "account must be in the chart");
  }
});

test("model produces double-entry journals and a balanced trial balance", () => {
  const model = buildAccountingModel(detail);
  // Two legs per transaction with a debit or credit.
  const posting = txns.filter((t) => (t.debitAmount ?? 0) > 0 || (t.creditAmount ?? 0) > 0).length;
  assert.equal(model.journals.length, posting * 2, "each transaction posts two legs");
  // Debits equal credits (double-entry).
  assert.ok(Math.abs(model.trialBalance.totalDebit - model.trialBalance.totalCredit) < 0.01, "TB must balance");
  assert.equal(model.trialBalance.balanced, true);
  // GL is not one suspense line.
  assert.ok(model.ledger.length > 1, "ledger must have multiple accounts");
  assert.ok(model.ledger.some((a: { name: string }) => a.name === "Cash at Bank"), "bank account posts every leg");
});

test("model VAT ties output/input to the transactions", () => {
  const model = buildAccountingModel(detail);
  // In this fixture the sales/deposits are VAT "review" (no output VAT); only the
  // bank fee and fuel are standard-rated debits => input VAT on those only.
  assert.equal(Math.round(model.vat201.outputVat * 100) / 100, 0, "no output VAT when sales are under review");
  const expectedInput = Math.round((616.8 + 1000) * (15 / 115) * 100) / 100;
  assert.equal(Math.round(model.vat201.inputVat * 100) / 100, expectedInput, "input VAT ties to standard expenses");
});

test("financials come from the ledger — tax/suspense are not revenue/expense", () => {
  const model = buildAccountingModel(detail);
  const revNames = model.financials.revenue.map((r: { name: string }) => r.name);
  const expNames = model.financials.expenses.map((e: { name: string }) => e.name);
  assert.ok(!revNames.includes("SARS / Tax Liability"), "tax is not revenue");
  assert.ok(!expNames.some((n: string) => /suspense/i.test(n)), "suspense is not an expense");
  assert.ok(model.financials.balanceSheet.liabilities.some((l: { name: string }) => /SARS|Suspense/.test(l.name)), "tax/suspense sit on the balance sheet");
});

// ─── Pack structure & export selector ──────────────────────────────────────

test("workbook is limited to approved core sheets (no extras, no placeholders)", () => {
  const sheets = packSheets(detail);
  assert.ok(sheets.length <= 18, `too many sheets: ${sheets.length}`);
  for (const s of sheets) {
    assert.ok(APPROVED_SHEETS.has(s.sheet), `unapproved sheet: ${s.sheet}`);
    // No placeholder sheets — every sheet has real content beyond a title row.
    assert.ok(s.rows.length > 1, `placeholder sheet: ${s.sheet}`);
  }
});

test("export selector lists every available export and each maps to a real section", () => {
  // Full pack + 13 individual options = 14.
  assert.equal(EXPORT_MENU.length, 14, "modal must offer 14 exports");
  assert.equal(EXPORT_MENU[0].section, "all", "first option is the full pack");
  const all = buildExportSections(detail, "ACAPOLITE CONSULTING (PTY) LTD");
  const ids = new Set(all.map((s: { id: string }) => s.id));
  for (const option of EXPORT_MENU) {
    if (option.section === "all") {
      assert.ok(FULL_PACK_SECTIONS.length > 0, "full pack must have sections");
    } else {
      assert.ok(ids.has(option.section), `export option "${option.label}" has no section`);
    }
  }
  // Every option label matches an approved export name.
  const labels = EXPORT_MENU.map((o) => o.label);
  for (const expected of ["Full Accounting Pack", "Transactions", "Review Queue", "VAT Working Paper", "General Ledger", "Trial Balance", "Profit & Loss", "Balance Sheet", "Cash Flow", "Bank Reconciliation", "AI Accountant Notes", "Audit Exceptions", "Data Quality Report", "Extraction Log"]) {
    assert.ok(labels.includes(expected), `missing export option: ${expected}`);
  }
});

test("cash deposits are excluded from final P&L revenue", () => {
  const pl = computeProfitLoss(txns, run);
  const revenueCats = pl.revenue.map((r: { category: string }) => r.category);
  const excludedCats = pl.excluded.map((e: { category: string }) => e.category);
  assert.ok(!revenueCats.includes("Cash Deposits / Revenue"), "cash deposits are not final revenue");
  assert.ok(excludedCats.includes("Cash Deposits / Revenue"), "cash deposits go to excluded pending review");
});

test("declared bank VAT appears in the VAT working paper", () => {
  const sections = buildExportSections(detail, "ACAPOLITE CONSULTING (PTY) LTD");
  const vat = sections.find((s: { id: string }) => s.id === "vat");
  const text = vat.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  assert.match(text, /Declared Bank VAT/, "VAT sheet must surface declared bank VAT");
  assert.match(text, /Estimated SARS VAT201/, "VAT201 boxes must be embedded in the VAT sheet");
});

test("unreliable reports are watermarked but still exportable when reconciliation fails", () => {
  const sheets = packSheets(unbalancedDetail);
  // Pack still produces (export allowed with watermark).
  assert.ok(sheets.length > 0, "export must still be produced when unreconciled");
  const pl = sheets.find((s) => s.sheet === "Profit & Loss");
  const plText = (pl!.rows as unknown[]).map((r: unknown) => (r as unknown[]).map(cellText).join(" ")).join("\n");
  assert.match(plText, /UNRELIABLE|does not reconcile/, "P&L must be watermarked when unreconciled");
});
