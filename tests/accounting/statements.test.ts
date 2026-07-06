import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Load the "@/..." path alias so we can import the real accounting logic.
register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { computeProfitLoss, accountType } = await import("@/lib/accounting/analytics.ts");
const { buildExportSections, buildStatementMetadata, resolveCompanyName, FULL_PACK_SECTIONS, EXPORT_MENU } = await import("@/lib/accounting/export.ts");
const { buildAccountingModel, resolveAccount, CHART } = await import("@/lib/accounting/model.ts");
const { statementDisplayName, statementReferenceDate } = await import("@/lib/accounting/statement-name.ts");

// Regression: an ALLIANZ statement uploaded in July for a 31 March 2026 period
// must be named from the statement metadata, never the upload/current date.
test("statement name comes from the PDF period/date, not the upload date", () => {
  const uploadedInJuly = {
    statementPeriodStart: "2026-02-28",
    statementPeriodEnd: "2026-03-31",
    statementDate: "2026-03-31",
    createdAt: "2026-07-06T09:00:00.000Z",
    companyName: "ALLIANZ HOLDINGS (PTY) LTD",
  };
  assert.equal(statementDisplayName(uploadedInJuly), "March 2026 Statement");
  assert.notEqual(statementDisplayName(uploadedInJuly), "July 2026 Statement");
  assert.equal(statementReferenceDate(uploadedInJuly), "2026-03-31");

  // Statement date only (no period) still names from the statement, not upload.
  const dateOnly = { statementPeriodStart: null, statementPeriodEnd: null, statementDate: "2026-03-31", companyName: "ALLIANZ HOLDINGS (PTY) LTD" };
  assert.equal(statementDisplayName(dateOnly), "March 2026 Statement");

  // Period end wins even if only the period is present.
  const periodOnly = { statementPeriodStart: "2026-02-28", statementPeriodEnd: "2026-03-31", companyName: null };
  assert.equal(statementDisplayName(periodOnly), "March 2026 Statement");

  // The reference date NEVER comes from the upload date.
  const noDatesJulyUpload = { statementPeriodStart: null, statementPeriodEnd: null, statementDate: null, companyName: null };
  assert.equal(statementReferenceDate(noDatesJulyUpload), null);
});

// Before processing, the name must be a neutral placeholder — never a guessed
// month and never the upload month (the "July 2026 Statement" bug).
test("statement name is a neutral placeholder before processing", () => {
  const queued = { statementPeriodStart: null, statementPeriodEnd: null, statementDate: null, companyName: "ALLIANZ HOLDINGS (PTY) LTD", status: "queued" as const };
  assert.equal(statementDisplayName(queued), "Processing Statement…");
  assert.doesNotMatch(statementDisplayName(queued), /2026 Statement$/, "must not show a month before processing");

  const processing = { statementPeriodStart: null, statementPeriodEnd: null, statementDate: null, companyName: null, status: "processing" as const };
  assert.equal(statementDisplayName(processing), "Processing Statement…");

  const unknownNoCompany = { statementPeriodStart: null, statementPeriodEnd: null, statementDate: null, companyName: null };
  assert.equal(statementDisplayName(unknownNoCompany), "Statement (Awaiting Processing)");

  // Once processed, the same run renames to its statement month.
  const processed = { statementPeriodStart: "2026-02-28", statementPeriodEnd: "2026-03-31", statementDate: "2026-03-31", companyName: "ALLIANZ HOLDINGS (PTY) LTD", status: "completed" as const };
  assert.equal(statementDisplayName(processed), "March 2026 Statement");
});

// The only sheet names allowed in the professional workbook.
const APPROVED_SHEETS = new Set([
  "Cover",
  "Summary",
  "Transactions",
  "Review Queue",
  "VAT Working Paper",
  "General Ledger",
  "Trial Balance",
  "Profit & Loss",
  "Balance Sheet",
  "Cash Flow",
  "Bank Reconciliation",
  "Notes & Assumptions",
]);

// Terms that must NEVER appear anywhere in the workbook (DocuCoreX IP).
const FORBIDDEN_TERMS = [/\bAI\b/, /GPT/, /OpenAI/i, /machine learn/i, /rule engine/i, /learning engine/i, /\bprompt\b/i, /confidence/i, /journal no/i];

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

test("General Ledger is a running-balance ledger with real accounts", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const gl = sections.find((s: { id: string }) => s.id === "general-ledger");
  // Columns: Date, Reference, Description, Account, Debit, Credit, Running Balance, Review.
  const accountNames = new Set(gl.rows.slice(2, -1).map((r: unknown[]) => cellText(r[3])));
  assert.ok(accountNames.size > 1, "GL must have multiple accounts");
  assert.ok(accountNames.has("Bank Charges"), "GL must contain a Bank Charges account");
  // The Bank Charges debit must be the fee (616.80), never a cash deposit (23,550).
  const bankRow = gl.rows.find((r: unknown[]) => cellText(r[3]) === "Bank Charges" && Number((r[4] as { v?: number })?.v) > 0);
  assert.equal(Number((bankRow[4] as { v: number }).v), 616.8, "bank charges must be the fee, not a deposit");
  // Closing running balance ties to the statement.
  const totalsRow = gl.rows[gl.rows.length - 1];
  assert.equal(Number((totalsRow[6] as { v: number }).v), closing, "running balance must close at the statement closing balance");
});

test("Trial Balance is balanced with a variance and status", () => {
  const sections = buildExportSections(detail, resolveCompanyName(run.companyName, null));
  const tb = sections.find((s: { id: string }) => s.id === "trial-balance");
  const totalsRow = tb.rows.find((r: unknown[]) => cellText(r[0]) === "Totals");
  assert.equal(cellText(totalsRow[4]), "Balanced", "trial balance must show Balanced status");
  // Bank is a real ledger account (Cash at Bank), not a plugged "contra".
  const accountNames = tb.rows.map((r: unknown[]) => cellText(r[0]));
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

test("Trial Balance is marked review required when unreconciled", () => {
  const sections = buildExportSections(unbalancedDetail, "ACAPOLITE CONSULTING (PTY) LTD");
  const tb = sections.find((s: { id: string }) => s.id === "trial-balance");
  const text = tb.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  assert.match(text, /REVIEW REQUIRED/);
  assert.ok(!text.includes("Bank / Cash (contra)"), "must not hide the gap behind a contra");
});

test("Cash Flow and P&L are watermarked review required when unreconciled", () => {
  const sections = buildExportSections(unbalancedDetail, "ACAPOLITE CONSULTING (PTY) LTD");
  const cf = sections.find((s: { id: string }) => s.id === "cash-flow");
  const pl = sections.find((s: { id: string }) => s.id === "profit-loss");
  const cfText = cf.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  const plText = pl.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  assert.match(cfText, /REVIEW REQUIRED|does not tie/);
  assert.match(plText, /REVIEW REQUIRED|does not reconcile/);
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

test("workbook is exactly the 12 approved sheets (no extras, no placeholders)", () => {
  const sheets = packSheets(detail);
  assert.equal(sheets.length, 12, `expected 12 sheets, got ${sheets.length}`);
  for (const s of sheets) {
    assert.ok(APPROVED_SHEETS.has(s.sheet), `unapproved sheet: ${s.sheet}`);
    // No placeholder sheets — every sheet has real content beyond a title row.
    assert.ok(s.rows.length > 1, `placeholder sheet: ${s.sheet}`);
  }
});

test("no AI/engine terminology is exposed anywhere in the workbook", () => {
  for (const d of [detail, unbalancedDetail]) {
    const sheets = packSheets(d);
    for (const s of sheets) {
      const text = (s.rows as unknown[]).map((r) => (r as unknown[]).map(cellText).join(" ")).join("\n");
      for (const term of FORBIDDEN_TERMS) {
        assert.doesNotMatch(text, term, `sheet "${s.sheet}" exposes forbidden term ${term}`);
      }
    }
  }
});

test("export selector lists every available export and each maps to a real section", () => {
  // Full pack + 11 individual options = 12.
  assert.equal(EXPORT_MENU.length, 12, "modal must offer 12 exports");
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
  for (const expected of ["Full Accounting Pack", "Transactions", "Executive Summary", "VAT Working Paper", "General Ledger", "Trial Balance", "Profit & Loss", "Balance Sheet", "Cash Flow", "Bank Reconciliation", "Review Queue", "Transaction Insights Report"]) {
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

test("Transaction Insights Report builds with real content and no AI wording", () => {
  const sections = buildExportSections(detail, "ACAPOLITE CONSULTING (PTY) LTD");
  const insights = sections.find((s: { id: string }) => s.id === "transaction-insights");
  assert.ok(insights, "transaction-insights section must be built");
  const text = insights.rows.map((r: unknown[]) => r.map(cellText).join(" ")).join("\n");
  assert.match(text, /Transaction Insights Report/);
  assert.match(text, /Duplicate payment groups/);
  assert.match(text, /Related-party & director activity/);
  assert.match(text, /Summary notes/);
  for (const term of [/\bAI\b/, /GPT/, /OpenAI/i, /\bprompt\b/i, /confidence/i]) {
    assert.doesNotMatch(text, term, `insights report must not expose ${term}`);
  }
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
