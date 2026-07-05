import { createZip } from "@/lib/file-output";
import type { AccountingRunDetail, AccountingTransaction } from "@/lib/accounting/types";
import {
  computeProfitLoss,
  computeCashFlow,
  computeFinancialRatios,
  detectVatAnomalies,
  detectDuplicates,
  detectUnusualTransactions,
  detectDirectorTransactions,
  computeSarsRisk,
  computeForecast,
  buildAuditSummary,
} from "@/lib/accounting/analytics";

// ─── Cell model ─────────────────────────────────────────────────────────────
// One cell model drives BOTH the multi-sheet XLSX and per-section CSV so Cover,
// Summary, Dashboard etc. can never diverge. `style` controls font/fill/border;
// `fmt` controls number formatting (money renders negatives in red).

export type CellStyle = "plain" | "bold" | "title" | "header" | "good" | "warn" | "muted" | "total";
export type CellFmt = "money" | "int" | "percent";

export type Cell = {
  v: string | number;
  num?: boolean;
  fmt?: CellFmt;
  style?: CellStyle;
};

const S = (v: unknown): Cell => ({ v: v === null || v === undefined ? "" : String(v) });
const B = (v: string): Cell => ({ v, style: "bold" });
const TITLE = (v: string): Cell => ({ v, style: "title" });
const HDR = (v: string): Cell => ({ v, style: "header" });
const GOOD = (v: string): Cell => ({ v, style: "good" });
const WARN = (v: string): Cell => ({ v, style: "warn" });
const MUTE = (v: string): Cell => ({ v, style: "muted" });
const M = (v: number | null | undefined): Cell => ({ v: Number(v ?? 0), num: true, fmt: "money" });
const MT = (v: number | null | undefined): Cell => ({ v: Number(v ?? 0), num: true, fmt: "money", style: "total" });
const MW = (v: number | null | undefined): Cell => ({ v: Number(v ?? 0), num: true, fmt: "money", style: "warn" });
const INT = (v: number | null | undefined): Cell => ({ v: Number(v ?? 0), num: true, fmt: "int" });
const PCT = (v: number): Cell => ({ v, num: true, fmt: "percent" });

export type ExportSectionId =
  | "cover"
  | "summary"
  | "transactions"
  | "review-items"
  | "vat"
  | "general-ledger"
  | "trial-balance"
  | "bank-reconciliation"
  | "reconciliation-issues"
  | "profit-loss"
  | "balance-sheet"
  | "cash-flow"
  | "financial-statements"
  | "tax-vat"
  | "ai-intelligence"
  | "forecasting"
  | "audit-tools"
  | "assumptions"
  | "data-quality"
  | "extraction-log";

export type ExportSection = {
  id: ExportSectionId;
  label: string;
  sheet: string;
  rows: Cell[][];
  headerRow?: number; // 1-based; freezes rows above+including and enables filter
  filter?: boolean;
};

const VAT_RATE = 15 / 115;

const DISCLAIMER =
  "Draft management report generated from bank-statement data only. This is not a final IFRS or Companies Act financial statement and requires accountant review. No figures are fabricated — modules without sufficient source data are marked accordingly.";

// ─── Company name resolution (fixes the hardcoded / address title) ───────────

export function resolveCompanyName(
  companyName: string | null | undefined,
  workspaceCompany: string | null | undefined,
): string {
  const detected = (companyName ?? "").trim();
  if (detected) return detected;
  const workspace = (workspaceCompany ?? "").trim();
  if (workspace) return workspace;
  return "";
}

export function packTitle(resolvedCompany: string): string {
  return resolvedCompany ? `${resolvedCompany} — Bank Statement Accounting Pack` : "Bank Statement Accounting Pack";
}

// ─── Canonical statement metadata ────────────────────────────────────────────
// Built ONCE and consumed by every sheet. Nothing recomputes these figures.

export type StatementMetadata = {
  company: string;
  title: string;
  bank: string;
  accountNumber: string;
  statementPeriod: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  totalReceipts: number;
  totalPayments: number;
  bankCharges: number;
  transactionCount: number;
  reviewCount: number;
  confidence: number;
  estOutputVat: number;
  estInputVat: number;
  netVat: number;
  expectedClosing: number;
  reconciliationDifference: number;
  reconciled: boolean;
};

function isReviewItem(t: AccountingTransaction): boolean {
  return (
    t.reviewStatus === "needs_review" ||
    t.reviewStatus === "in_review" ||
    t.vatTreatment === "review" ||
    t.accountCategory === "Review Required" ||
    t.accountCategory === "Uncategorised Expense" ||
    t.confidence < 80
  );
}

function vatForTransaction(t: AccountingTransaction) {
  const isStandard = t.vatTreatment === "standard";
  const outputVat = isStandard ? (t.creditAmount ?? 0) * VAT_RATE : 0;
  const inputVat = isStandard ? (t.debitAmount ?? 0) * VAT_RATE : 0;
  return { outputVat, inputVat, netVat: outputVat - inputVat };
}

export function buildStatementMetadata(detail: AccountingRunDetail, resolvedCompany: string): StatementMetadata {
  const { run } = detail;
  const txns = detail.transactions;
  const totalReceipts = txns.reduce((s, t) => s + (t.creditAmount ?? 0), 0);
  const totalPayments = txns.reduce((s, t) => s + (t.debitAmount ?? 0), 0);
  const estOutputVat = txns.reduce((s, t) => s + vatForTransaction(t).outputVat, 0);
  const estInputVat = txns.reduce((s, t) => s + vatForTransaction(t).inputVat, 0);
  const opening = run.openingBalance ?? 0;
  const closing = run.closingBalance ?? 0;
  const expectedClosing = opening + totalReceipts - totalPayments;
  const reconciliationDifference = expectedClosing - closing;
  return {
    company: resolvedCompany,
    title: packTitle(resolvedCompany),
    bank: run.bank,
    accountNumber: run.accountNumber ?? "",
    statementPeriod: `${run.statementPeriodStart ?? "?"} to ${run.statementPeriodEnd ?? "?"}`,
    periodStart: run.statementPeriodStart ?? "",
    periodEnd: run.statementPeriodEnd ?? "",
    openingBalance: opening,
    closingBalance: closing,
    totalReceipts,
    totalPayments,
    bankCharges: run.bankChargesTotal,
    transactionCount: txns.length,
    reviewCount: txns.filter(isReviewItem).length,
    confidence: Math.round(run.confidence),
    estOutputVat,
    estInputVat,
    netVat: estOutputVat - estInputVat,
    expectedClosing,
    reconciliationDifference,
    reconciled: Math.abs(reconciliationDifference) < 0.01,
  };
}

function accountGroups(transactions: AccountingTransaction[]) {
  const groups = new Map<string, { debit: number; credit: number; count: number }>();
  for (const t of transactions) {
    const account = t.reviewStatus === "approved" ? t.accountCategory : "Review Required Suspense";
    const current = groups.get(account) ?? { debit: 0, credit: 0, count: 0 };
    current.debit += t.debitAmount ?? 0;
    current.credit += t.creditAmount ?? 0;
    current.count += 1;
    groups.set(account, current);
  }
  return Array.from(groups, ([account, v]) => ({ account, ...v })).sort((a, b) => a.account.localeCompare(b.account));
}

const VAT_LABELS: Record<string, string> = {
  standard: "Standard (15%)",
  zero_rated: "Zero-rated",
  exempt: "Exempt",
  out_of_scope: "Out of scope",
  review: "Review required",
};

function reviewReason(t: AccountingTransaction): string {
  if (t.vatTreatment === "review") return "VAT treatment unresolved";
  if (t.reviewStatus === "needs_review" || t.reviewStatus === "in_review") return "Flagged for review";
  if (t.accountCategory === "Review Required" || t.accountCategory === "Uncategorised Expense") return "Category unresolved";
  if (t.confidence < 80) return `Low confidence (${t.confidence}%)`;
  return "";
}

// ─── Section builders ───────────────────────────────────────────────────────

export function buildExportSections(detail: AccountingRunDetail, resolvedCompany: string): ExportSection[] {
  const meta = buildStatementMetadata(detail, resolvedCompany);
  const txns = detail.transactions;
  const reviews = txns.filter(isReviewItem);
  const totals = { debit: meta.totalPayments, credit: meta.totalReceipts, bankCharges: meta.bankCharges };
  const run = detail.run;

  const pl = computeProfitLoss(txns, run);
  const cashFlow = computeCashFlow(txns, run);
  const ratios = computeFinancialRatios(txns, run, totals);
  const forecast = computeForecast(txns, run, totals);
  const vatAnomalies = detectVatAnomalies(txns);
  const duplicates = detectDuplicates(txns);
  const unusuals = detectUnusualTransactions(txns);
  const directors = detectDirectorTransactions(txns);
  const risk = computeSarsRisk(txns, vatAnomalies, duplicates, unusuals, directors);
  const audit = buildAuditSummary(txns, run, duplicates, unusuals, vatAnomalies, risk);

  const sections: ExportSection[] = [];

  // Cover — canonical header + reconciliation banner
  sections.push({
    id: "cover",
    label: "Cover",
    sheet: "Cover",
    rows: [
      [TITLE(meta.title)],
      [],
      meta.reconciled
        ? [GOOD("Status: Balanced — opening + receipts − payments = closing")]
        : [WARN(`REVIEW REQUIRED — reconciliation difference of R${Math.abs(meta.reconciliationDifference).toFixed(2)}. See Reconciliation Issues.`)],
      [],
      [B("Company / account holder"), S(meta.company || "Not detected")],
      [B("Bank"), S(meta.bank)],
      [B("Account number"), S(meta.accountNumber)],
      [B("Statement period"), S(meta.statementPeriod)],
      [B("Opening balance"), M(meta.openingBalance)],
      [B("Closing balance"), M(meta.closingBalance)],
      [B("Total receipts"), M(meta.totalReceipts)],
      [B("Total payments"), M(meta.totalPayments)],
      [B("Transactions"), INT(meta.transactionCount)],
      [B("Review items"), INT(meta.reviewCount)],
      [B("Extraction confidence"), S(`${meta.confidence}%`)],
      [B("Generated"), S(new Date().toISOString().slice(0, 10))],
      [],
      [MUTE(DISCLAIMER)],
    ],
  });

  // Summary — same canonical metadata as the Cover
  sections.push({
    id: "summary",
    label: "Bank Statement Summary",
    sheet: "Summary",
    headerRow: 1,
    rows: [
      [HDR("Metric"), HDR("Value")],
      [S("Company"), S(meta.company)],
      [S("Account number"), S(meta.accountNumber)],
      [S("Statement period start"), S(meta.periodStart)],
      [S("Statement period end"), S(meta.periodEnd)],
      [S("Opening balance"), M(meta.openingBalance)],
      [S("Total receipts"), M(meta.totalReceipts)],
      [S("Total payments"), M(meta.totalPayments)],
      [S("Closing balance"), M(meta.closingBalance)],
      [S("Net movement"), M(meta.totalReceipts - meta.totalPayments)],
      [S("Expected closing (recon)"), M(meta.expectedClosing)],
      [S("Reconciliation difference"), meta.reconciled ? M(0) : MW(meta.reconciliationDifference)],
      [S("Transactions extracted"), INT(meta.transactionCount)],
      [S("Review items"), INT(meta.reviewCount)],
      [S("Bank charges"), M(meta.bankCharges)],
      [S("Est. Output VAT"), M(meta.estOutputVat)],
      [S("Est. Input VAT"), M(meta.estInputVat)],
      [S("Net VAT position"), M(meta.netVat)],
    ],
  });

  // Transactions
  sections.push({
    id: "transactions",
    label: "Transactions",
    sheet: "Transactions",
    headerRow: 1,
    filter: true,
    rows: [
      [HDR("Date"), HDR("Description"), HDR("Money In"), HDR("Money Out"), HDR("Balance"), HDR("Account"), HDR("VAT Treatment"), HDR("Review"), HDR("Confidence"), HDR("Notes")],
      ...txns.map((t) => [
        S(t.transactionDate ?? ""),
        S(t.description),
        M(t.creditAmount ?? 0),
        M(t.debitAmount ?? 0),
        M(t.runningBalance ?? 0),
        S(t.accountCategory),
        S(VAT_LABELS[t.vatTreatment] ?? t.vatTreatment),
        S(t.reviewStatus),
        INT(t.confidence),
        S(t.notes),
      ]),
      [B("Totals"), S(""), MT(meta.totalReceipts), MT(meta.totalPayments), S(""), S(""), S(""), S(""), S(""), S("")],
    ],
  });

  // Review Items
  sections.push({
    id: "review-items",
    label: "Review Items",
    sheet: "Review Items",
    headerRow: 1,
    filter: reviews.length > 0,
    rows: [
      [HDR("Date"), HDR("Description"), HDR("Money In"), HDR("Money Out"), HDR("Account"), HDR("VAT Treatment"), HDR("Review Status"), HDR("Reason"), HDR("Confidence")],
      ...(reviews.length
        ? reviews.map((t) => [
            S(t.transactionDate ?? ""),
            S(t.description),
            M(t.creditAmount ?? 0),
            M(t.debitAmount ?? 0),
            S(t.accountCategory),
            S(VAT_LABELS[t.vatTreatment] ?? t.vatTreatment),
            WARN(t.reviewStatus),
            S(reviewReason(t)),
            INT(t.confidence),
          ])
        : [[GOOD("No items require review.")]]),
    ],
  });

  // VAT Schedule (fixes #7)
  const vatDetailRows: Cell[][] = txns.map((t) => {
    const { outputVat, inputVat, netVat } = vatForTransaction(t);
    const claim =
      t.vatTreatment === "review"
        ? "Review required"
        : t.vatTreatment === "standard"
          ? t.supportedByInvoice
            ? "Claimable (invoice on file)"
            : "Invoice required"
          : VAT_LABELS[t.vatTreatment] ?? t.vatTreatment;
    const netCell = netVat < 0 ? { v: netVat, num: true, fmt: "money" as const } : M(netVat);
    return [
      S(t.transactionDate ?? ""),
      S(t.description),
      M(t.creditAmount ?? 0),
      M(t.debitAmount ?? 0),
      S(VAT_LABELS[t.vatTreatment] ?? t.vatTreatment),
      S(claim),
      M(outputVat),
      M(inputVat),
      netCell,
      S(t.supportedByInvoice ? "Invoice on file" : "No document"),
      S(reviewReason(t) || "—"),
      INT(t.confidence),
    ];
  });
  sections.push({
    id: "vat",
    label: "VAT Schedule",
    sheet: "VAT Schedule",
    headerRow: 6,
    filter: true,
    rows: [
      [TITLE("VAT Schedule")],
      [MUTE("VAT estimated at 15% inclusive (15/115) on standard-rated transactions. Verify against SARS VAT201. Not tax advice.")],
      [],
      [B("Est. Output VAT"), M(meta.estOutputVat), B("Est. Input VAT"), M(meta.estInputVat), B("Net VAT Position"), M(meta.netVat)],
      [],
      [HDR("Date"), HDR("Description"), HDR("Money In"), HDR("Money Out"), HDR("VAT Treatment"), HDR("Claim Status"), HDR("Output VAT"), HDR("Input VAT"), HDR("Net VAT"), HDR("Document Status"), HDR("Review Reason"), HDR("Confidence")],
      ...vatDetailRows,
      [B("Totals"), S(""), S(""), S(""), S(""), S(""), MT(meta.estOutputVat), MT(meta.estInputVat), MT(meta.netVat), S(""), S(""), S("")],
    ],
  });

  // General Ledger
  const groups = accountGroups(txns);
  sections.push({
    id: "general-ledger",
    label: "General Ledger",
    sheet: "General Ledger",
    headerRow: 1,
    filter: true,
    rows: [
      [HDR("Account"), HDR("Transactions"), HDR("Debits"), HDR("Credits"), HDR("Net Movement")],
      ...groups.map((g) => [S(g.account), INT(g.count), M(g.debit), M(g.credit), M(g.credit - g.debit)]),
      [B("Totals"), INT(txns.length), MT(meta.totalPayments), MT(meta.totalReceipts), MT(meta.totalReceipts - meta.totalPayments)],
    ],
  });

  // Trial Balance
  const drTotal = groups.reduce((s, g) => s + Math.max(0, g.debit - g.credit), 0);
  const crTotal = groups.reduce((s, g) => s + Math.max(0, g.credit - g.debit), 0);
  sections.push({
    id: "trial-balance",
    label: "Trial Balance",
    sheet: "Trial Balance",
    headerRow: 3,
    rows: [
      [MUTE("Derived from AI-assigned transaction categories. Not a full double-entry trial balance — the bank contra account is not represented.")],
      [],
      [HDR("Account"), HDR("Debit Balance"), HDR("Credit Balance")],
      ...groups.map((g) => {
        const net = g.debit - g.credit;
        return [S(g.account), M(net > 0 ? net : 0), M(net < 0 ? Math.abs(net) : 0)];
      }),
      [B("Totals"), MT(drTotal), MT(crTotal)],
    ],
  });

  // Bank Reconciliation
  sections.push({
    id: "bank-reconciliation",
    label: "Bank Reconciliation",
    sheet: "Bank Reconciliation",
    headerRow: 1,
    rows: [
      [HDR("Bank Reconciliation"), HDR("Amount")],
      [S("Opening Balance"), M(meta.openingBalance)],
      [S("+ Receipts"), M(meta.totalReceipts)],
      [S("- Payments"), M(meta.totalPayments)],
      [B("= Expected Closing Balance"), MT(meta.expectedClosing)],
      [S("Statement Closing Balance"), M(meta.closingBalance)],
      [B("Difference"), meta.reconciled ? MT(0) : MW(meta.reconciliationDifference)],
      [S("Status"), meta.reconciled ? GOOD("Reconciled") : WARN("Review required")],
      [S("Bank charges"), M(meta.bankCharges)],
      [S("Bank VAT (15/115)"), M(meta.bankCharges * VAT_RATE)],
    ],
  });

  // Reconciliation Issues — only when unbalanced (never silently export bad values)
  if (!meta.reconciled) {
    sections.push({
      id: "reconciliation-issues",
      label: "Reconciliation Issues",
      sheet: "Reconciliation Issues",
      rows: [
        [TITLE("Reconciliation Issues")],
        [WARN("This statement does not reconcile. Do not use these figures for filing until resolved.")],
        [],
        [B("Opening balance"), M(meta.openingBalance)],
        [B("+ Receipts"), M(meta.totalReceipts)],
        [B("- Payments"), M(meta.totalPayments)],
        [B("= Expected closing"), M(meta.expectedClosing)],
        [B("Statement closing"), M(meta.closingBalance)],
        [B("Difference"), MW(meta.reconciliationDifference)],
        [],
        [B("Likely causes")],
        [S("Missing or duplicated transactions during extraction")],
        [S("Opening/closing balance mis-read from the statement")],
        [S("Bank charges or interest not captured on separate lines")],
        [],
        [B("What is needed")],
        [S("Re-check the source statement totals and re-process, or adjust the affected transactions in the review queue.")],
      ],
    });
  }

  // Profit & Loss
  sections.push({
    id: "profit-loss",
    label: "Profit & Loss",
    sheet: "Profit & Loss",
    headerRow: 4,
    rows: [
      [TITLE("Profit & Loss (cash basis)")],
      [MUTE(pl.note)],
      [],
      [HDR("Income"), HDR("Count"), HDR("Amount")],
      ...pl.revenue.map((r) => [S(r.category), INT(r.count), M(r.amount)]),
      [B("Total Revenue"), S(""), MT(pl.totalRevenue)],
      [],
      [HDR("Expenses"), HDR("Count"), HDR("Amount")],
      ...pl.expenses.map((e) => [S(e.category), INT(e.count), M(e.amount)]),
      [B("Total Expenses"), S(""), MT(pl.totalExpenses)],
      [],
      [B(pl.netSurplus >= 0 ? "Net Surplus" : "Net Deficit"), S(""), pl.netSurplus >= 0 ? MT(pl.netSurplus) : MW(pl.netSurplus)],
      [MUTE("Inter-account transfers excluded"), S(""), M(pl.interAccountTransfers)],
    ],
  });

  // Balance Sheet (partial — explained, not fabricated)
  sections.push({
    id: "balance-sheet",
    label: "Balance Sheet",
    sheet: "Balance Sheet",
    rows: [
      [TITLE("Balance Sheet")],
      [WARN("Status: Partial — cash position only")],
      [],
      [HDR("Available from bank data"), HDR("Amount")],
      [S("Cash at bank (closing balance)"), M(meta.closingBalance)],
      [],
      [B("Not available from a single bank statement")],
      [MUTE("Fixed assets, debtors, creditors, inventory, loans, equity and retained earnings")],
      [],
      [B("Data needed for a full balance sheet")],
      [MUTE("General ledger, asset register, accounts receivable/payable, loan schedules and prior-year equity")],
      [],
      [MUTE("No figures are fabricated. A full IFRS balance sheet requires accountant input.")],
    ],
  });

  // Cash Flow
  sections.push({
    id: "cash-flow",
    label: "Cash Flow",
    sheet: "Cash Flow",
    rows: [
      [TITLE("Cash Flow (direct method)")],
      [MUTE(cashFlow.note)],
      [],
      [B("Opening balance"), M(cashFlow.openingBalance)],
      [B("Closing balance"), M(cashFlow.closingBalance)],
      [],
      [HDR("Inflows"), HDR("Amount")],
      ...cashFlow.inflows.map((i) => [S(i.label), M(i.amount)]),
      [B("Total inflows"), MT(cashFlow.totalInflows)],
      [],
      [HDR("Outflows"), HDR("Amount")],
      ...cashFlow.outflows.map((o) => [S(o.label), M(o.amount)]),
      [B("Total outflows"), MT(cashFlow.totalOutflows)],
      [],
      [B("Net movement"), MT(cashFlow.netMovement)],
      [B("Reconciled"), cashFlow.reconciled ? GOOD("Yes") : WARN("No — check for missing transactions")],
    ],
  });

  // Financial Ratios
  sections.push({
    id: "financial-statements",
    label: "Financial Ratios",
    sheet: "Financial Ratios",
    headerRow: 4,
    rows: [
      [TITLE("Financial Ratios")],
      [MUTE(ratios.note)],
      [],
      [HDR("Ratio"), HDR("Value")],
      [S("Expense ratio"), ratios.expenseRatio !== null ? PCT(ratios.expenseRatio) : S("—")],
      [S("Net cash margin"), ratios.netCashMargin !== null ? PCT(ratios.netCashMargin / 100) : S("—")],
      [S("Cash coverage"), S(ratios.cashCoverageRatio !== null ? `${ratios.cashCoverageRatio.toFixed(2)}x` : "—")],
      [S("Avg monthly income"), M(ratios.avgMonthlyIncome ?? 0)],
      [S("Avg monthly expenses"), M(ratios.avgMonthlyExpenses ?? 0)],
      [S("Net monthly cash flow"), M(ratios.netMonthlyCashFlow ?? 0)],
      [S("Bank charges ratio"), ratios.bankChargesRatio !== null ? PCT(ratios.bankChargesRatio / 100) : S("—")],
      [S("Period (months)"), INT(ratios.periodMonths)],
    ],
  });

  // Tax & VAT
  sections.push({
    id: "tax-vat",
    label: "Tax & VAT Intelligence",
    sheet: "Tax & VAT",
    rows: [
      [TITLE("Tax & VAT Intelligence")],
      [B("Internal SARS risk score"), S(`${risk.score}/100 (${risk.level})`)],
      [MUTE(risk.summary)],
      [],
      [HDR("Risk factor"), HDR("Score"), HDR("Max"), HDR("Detail")],
      ...risk.factors.map((f) => [S(f.name), INT(f.score), INT(f.maxScore), S(f.detail)]),
      [],
      [HDR("VAT anomalies"), HDR("Severity"), HDR("Amount"), HDR("Detail")],
      ...(vatAnomalies.length
        ? vatAnomalies.map((a) => [S(a.type), WARN(a.severity), M(a.amount), S(a.description)])
        : [[GOOD("No VAT anomalies detected.")]]),
      [],
      [MUTE("Internal advisory only. Not a SARS assessment or tax advice.")],
    ],
  });

  // AI Intelligence
  sections.push({
    id: "ai-intelligence",
    label: "AI Intelligence",
    sheet: "AI Intelligence",
    rows: [
      [TITLE("AI Transaction Intelligence")],
      [B(`Duplicate groups: ${duplicates.length}`), B(`Unusual: ${unusuals.length}`), B(`Director-linked: ${directors.length}`)],
      [],
      [HDR("Potential duplicate payments"), HDR("Amount"), HDR("Count"), HDR("Confidence")],
      ...(duplicates.length
        ? duplicates.map((d) => [S(d.transactions[0]?.description ?? ""), M(d.amount), INT(d.transactions.length), S(`${d.confidence}%`)])
        : [[GOOD("No duplicate payments detected.")]]),
      [],
      [HDR("Unusual transactions"), HDR("Amount"), HDR("Reason")],
      ...(unusuals.length
        ? unusuals.map((u) => [S(u.transaction.description), M(u.transaction.debitAmount ?? u.transaction.creditAmount ?? 0), S(u.reason)])
        : [[GOOD("No unusual transactions detected.")]]),
      [],
      [HDR("Director / related-party"), HDR("Amount"), HDR("Matched")],
      ...(directors.length
        ? directors.map((d) => [S(d.transaction.description), M(d.transaction.debitAmount ?? d.transaction.creditAmount ?? 0), S(d.matchedKeyword)])
        : [[GOOD("No director-linked transactions detected.")]]),
    ],
  });

  // Forecasting
  sections.push({
    id: "forecasting",
    label: "Forecasting",
    sheet: "Forecasting",
    headerRow: 8,
    rows: [
      [TITLE("Cash Flow Forecast")],
      [MUTE(forecast.note)],
      [],
      [B("Monthly avg income"), M(forecast.monthlyAvgIncome)],
      [B("Monthly avg expenses"), M(forecast.monthlyAvgExpenses)],
      [B("Monthly net flow"), M(forecast.monthlyNetFlow)],
      [],
      [HDR("Month"), HDR("Projected Income"), HDR("Projected Expenses"), HDR("Net Flow"), HDR("Closing Balance")],
      ...forecast.projections.map((p) => [S(p.label), M(p.projectedIncome), M(p.projectedExpenses), M(p.projectedNetFlow), M(p.projectedClosingBalance)]),
    ],
  });

  // Audit Tools
  sections.push({
    id: "audit-tools",
    label: "Audit Tools",
    sheet: "Audit Tools",
    rows: [
      [TITLE("Audit Pack")],
      [B("Risk"), S(`${audit.riskScore.score}/100 (${audit.riskScore.level})`)],
      [B("Review items"), INT(audit.reviewItems)],
      [B("Uncategorised"), INT(audit.uncategorized)],
      [B("Payments >R5k without invoice"), INT(audit.transactionsNeedingInvoice.length)],
      [],
      [HDR("Finding"), HDR("Severity"), HDR("Category"), HDR("Detail")],
      ...(audit.findings.length
        ? audit.findings.map((f) => [
            S(f.title),
            f.severity === "high" || f.severity === "critical" ? WARN(f.severity) : S(f.severity),
            S(f.category),
            S(f.detail),
          ])
        : [[GOOD("No audit findings. Statement appears complete and well-classified.")]]),
    ],
  });

  // Assumptions / Limitations
  sections.push({
    id: "assumptions",
    label: "Assumptions & Limitations",
    sheet: "Assumptions",
    headerRow: 4,
    rows: [
      [TITLE("Assumptions & Limitations")],
      [MUTE(DISCLAIMER)],
      [],
      [HDR("Module"), HDR("Status"), HDR("Notes")],
      [S("Profit & Loss"), S("Cash basis"), MUTE("Excludes accruals, depreciation, prepayments and capital items.")],
      [S("Balance Sheet"), S("Partial"), MUTE("Cash position only. Full statement needs GL, assets, liabilities, equity.")],
      [S("Cash Flow"), S("Direct method"), MUTE("Investing/financing activities not separately classified.")],
      [S("VAT"), S("Estimated"), MUTE("15% inclusive on standard-rated lines. Verify against tax invoices and VAT201.")],
      [S("SARS Risk"), S("Advisory"), MUTE("Internal 0–100 score. Not a SARS assessment or tax advice.")],
      [S("Forecasting"), S(forecast.periodMonths <= 1 ? "Single period" : "Multi-period"), MUTE("Assumes consistent patterns; process more statements to improve.")],
      [S("Trial Balance"), S("Indicative"), MUTE("Not double-entry; bank contra account not represented.")],
      [S("Reconciliation"), meta.reconciled ? S("Balanced") : S("Review required"), MUTE(meta.reconciled ? "Opening + receipts − payments = closing." : "See Reconciliation Issues sheet.")],
    ],
  });

  // Data Quality Report — the extraction "hard gate".
  const uncategorised = txns.filter(
    (t) => /uncategori|review required|operating expenses/i.test(t.accountCategory),
  ).length;
  const lowConfidence = txns.filter((t) => t.confidence < 70).length;
  const withoutInvoice = txns.filter((t) => (t.debitAmount ?? 0) > 5000 && !t.supportedByInvoice && !t.bankCharge).length;
  const extractionOk = meta.reconciled;
  sections.push({
    id: "data-quality",
    label: "Data Quality Report",
    sheet: "Data Quality",
    headerRow: 5,
    rows: [
      [TITLE("Data Quality Report")],
      extractionOk
        ? [GOOD("Extraction status: COMPLETE — statement reconciles.")]
        : [WARN("Extraction status: REVIEW REQUIRED — statement does not reconcile. Figures may be incomplete; do not rely on the financial statements until resolved.")],
      [],
      [MUTE("This report flags data-quality issues so misleading statements are never presented as final.")],
      [HDR("Check"), HDR("Result"), HDR("Detail")],
      [S("Reconciliation"), meta.reconciled ? GOOD("Pass") : WARN("Fail"), meta.reconciled ? S("Balanced") : MW(meta.reconciliationDifference)],
      [S("Review items"), meta.reviewCount === 0 ? GOOD("0") : WARN(String(meta.reviewCount)), S("Transactions needing accountant review")],
      [S("Uncategorised"), uncategorised === 0 ? GOOD("0") : WARN(String(uncategorised)), S("Assign accounts before posting")],
      [S("Low confidence (<70%)"), lowConfidence === 0 ? GOOD("0") : WARN(String(lowConfidence)), S("Verify amounts and descriptions")],
      [S("Payments >R5k without invoice"), withoutInvoice === 0 ? GOOD("0") : WARN(String(withoutInvoice)), S("Attach supporting documents")],
      [S("Extraction confidence"), S(`${meta.confidence}%`), S("Overall parser confidence")],
      [S("Transactions extracted"), INT(meta.transactionCount), S("Rows captured from the statement")],
    ],
  });

  // Extraction Log — provenance of every figure.
  sections.push({
    id: "extraction-log",
    label: "Extraction Log",
    sheet: "Extraction Log",
    headerRow: 1,
    rows: [
      [HDR("Field"), HDR("Value")],
      [S("Bank"), S(run.bank)],
      [S("Statement type"), S(run.statementType)],
      [S("Extraction provider"), S(run.extractionProvider)],
      [S("Parser profile"), S(run.parserProfile ?? "—")],
      [S("Parser version"), S(run.parserVersion ?? "—")],
      [S("Processing status"), S(run.status)],
      [S("Extraction confidence"), S(`${meta.confidence}%`)],
      [S("Company (as extracted)"), S(meta.company || "Not detected")],
      [S("Account number (as extracted)"), S(meta.accountNumber || "Not detected")],
      [S("Statement period"), S(meta.statementPeriod)],
      [S("Opening balance"), M(meta.openingBalance)],
      [S("Closing balance"), M(meta.closingBalance)],
      [S("Reconciliation difference"), meta.reconciled ? M(0) : MW(meta.reconciliationDifference)],
      [S("Generated"), S(new Date().toISOString())],
    ],
  });

  return sections;
}

// ─── CSV renderer ───────────────────────────────────────────────────────────

function csvCell(cell: Cell): string {
  const text = cell.num ? String(cell.v) : String(cell.v);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function sectionToCsv(section: ExportSection): string {
  return section.rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

// ─── XLSX renderer (multi-sheet, styled, auto-fit, frozen, filtered) ─────────

const encoder = new TextEncoder();
const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function sanitizeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31).trim() || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base.slice(0, 28)} ${i}`;
    i += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// cellXfs indices (see STYLES_XML): resolve from cell shape.
function xfIndex(cell: Cell): number {
  if (cell.num) {
    if (cell.fmt === "int") return 10;
    if (cell.fmt === "percent") return 11;
    if (cell.style === "total") return 9;
    if (cell.style === "warn") return 12;
    if (cell.style === "good") return 13;
    return 8; // money
  }
  switch (cell.style) {
    case "bold":
      return 1;
    case "title":
      return 2;
    case "header":
      return 3;
    case "good":
      return 4;
    case "warn":
      return 5;
    case "muted":
      return 6;
    case "total":
      return 7;
    default:
      return 0;
  }
}

function displayLen(cell: Cell): number {
  if (cell.num) {
    if (cell.fmt === "percent") return 6;
    const abs = Math.abs(Number(cell.v));
    return abs.toLocaleString("en-ZA", { minimumFractionDigits: cell.fmt === "int" ? 0 : 2 }).length + 2;
  }
  return String(cell.v).length;
}

function cellXml(cell: Cell, ref: string): string {
  const s = xfIndex(cell);
  if (cell.num) {
    const v = Number.isFinite(Number(cell.v)) ? Number(cell.v) : 0;
    return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  }
  return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(String(cell.v))}</t></is></c>`;
}

function sheetXml(section: ExportSection): string {
  const rows = section.rows;
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 1);

  // Column widths (auto-fit, clamped).
  const widths: number[] = [];
  for (let c = 0; c < maxCols; c += 1) {
    let w = 10;
    for (const row of rows) {
      if (row[c]) w = Math.max(w, displayLen(row[c]) + 1);
    }
    widths.push(Math.min(60, w));
  }
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join("")}</cols>`;

  const body = rows
    .map((row, r) => {
      const cells = row.map((cell, c) => cellXml(cell, `${colLetter(c)}${r + 1}`)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");

  // Freeze rows above+including the header row.
  const freeze = section.headerRow
    ? `<sheetView tabSelected="0" workbookViewId="0"><pane ySplit="${section.headerRow}" topLeftCell="A${section.headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
    : `<sheetView workbookViewId="0"/>`;
  const sheetViews = `<sheetViews>${freeze}</sheetViews>`;

  const lastRow = rows.length;
  const lastCol = colLetter(maxCols - 1);
  const autoFilter =
    section.filter && section.headerRow ? `<autoFilter ref="A${section.headerRow}:${lastCol}${lastRow}"/>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetViews}${cols}<sheetData>${body}</sheetData>${autoFilter}</worksheet>`;
}

// Fonts: 0 default, 1 bold, 2 bold-white, 3 green, 4 grey
// Fills: 0 none, 1 gray125, 2 navy(title), 3 blue(header), 4 lightgreen, 5 lightorange, 6 lightgrey
// Borders: 0 none, 1 top-thin
// numFmts: 164 money(red-neg), 165 int, 166 percent
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts><fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF15803D"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF64748B"/><name val="Calibri"/></font></fonts><fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFEDD5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF94A3B8"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="14"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="4" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/><xf numFmtId="164" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function sectionsToXlsx(sections: ExportSection[]): Uint8Array {
  const used = new Set<string>();
  const named = sections.map((s) => ({ ...s, tab: sanitizeSheetName(s.sheet, used) }));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("")}</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbookSheets = named.map((s, i) => `<sheet name="${xml(s.tab)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`;

  const stylesRelId = named.length + 1;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("")}<Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  const entries = [
    { name: "[Content_Types].xml", content: encoder.encode(contentTypes) },
    { name: "_rels/.rels", content: encoder.encode(rootRels) },
    { name: "xl/workbook.xml", content: encoder.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", content: encoder.encode(workbookRels) },
    { name: "xl/styles.xml", content: encoder.encode(STYLES_XML) },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: encoder.encode(sheetXml(s)) })),
  ];

  return createZip(entries);
}
