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
// A cell is either a string (optionally styled) or a number. Number cells are
// rendered with a red-negative money format in XLSX. This one model feeds both
// the multi-sheet XLSX and the per-section CSV so the two never diverge.

export type Cell =
  | { k: "s"; v: string; style?: "plain" | "bold" | "title" }
  | { k: "n"; v: number; money?: boolean };

const S = (v: unknown): Cell => ({ k: "s", v: v === null || v === undefined ? "" : String(v) });
const B = (v: string): Cell => ({ k: "s", v, style: "bold" });
const T = (v: string): Cell => ({ k: "s", v, style: "title" });
const M = (v: number | null | undefined): Cell => ({ k: "n", v: Number(v ?? 0), money: true });
const N = (v: number | null | undefined): Cell => ({ k: "n", v: Number(v ?? 0) });

export type ExportSectionId =
  | "cover"
  | "summary"
  | "transactions"
  | "review-items"
  | "vat"
  | "general-ledger"
  | "trial-balance"
  | "bank-reconciliation"
  | "profit-loss"
  | "balance-sheet"
  | "cash-flow"
  | "financial-statements"
  | "tax-vat"
  | "ai-intelligence"
  | "forecasting"
  | "audit-tools"
  | "assumptions";

export type ExportSection = {
  id: ExportSectionId;
  label: string; // human label (modal + file name)
  sheet: string; // XLSX tab name (<=31 chars, sanitized later)
  rows: Cell[][];
};

const VAT_RATE = 15 / 115;

const DISCLAIMER =
  "Draft management report generated from bank-statement data only. This is not a final IFRS or Companies Act financial statement and requires accountant review. No figures are fabricated — modules without sufficient source data are marked accordingly.";

// ─── Company name resolution (fixes the hardcoded title) ─────────────────────

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
  return resolvedCompany
    ? `${resolvedCompany} — Bank Statement Accounting Pack`
    : "Bank Statement Accounting Pack";
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

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
  return Array.from(groups, ([account, v]) => ({ account, ...v })).sort((a, b) =>
    a.account.localeCompare(b.account),
  );
}

const VAT_LABELS: Record<string, string> = {
  standard: "Standard (15%)",
  zero_rated: "Zero-rated",
  exempt: "Exempt",
  out_of_scope: "Out of scope",
  review: "Review required",
};

// Per-transaction VAT. Output VAT on receipts, input VAT on payments, only for
// standard-rated lines (SA 15% inclusive = 15/115). Never silently zeroes a line
// that has a real VAT treatment — the treatment is always shown.
function vatForTransaction(t: AccountingTransaction) {
  const isStandard = t.vatTreatment === "standard";
  const outputVat = isStandard ? (t.creditAmount ?? 0) * VAT_RATE : 0;
  const inputVat = isStandard ? (t.debitAmount ?? 0) * VAT_RATE : 0;
  return { outputVat, inputVat, netVat: outputVat - inputVat };
}

// ─── Section builders ───────────────────────────────────────────────────────

export function buildExportSections(
  detail: AccountingRunDetail,
  resolvedCompany: string,
): ExportSection[] {
  const { run } = detail;
  const txns = detail.transactions;
  const totalDebits = txns.reduce((s, t) => s + (t.debitAmount ?? 0), 0);
  const totalCredits = txns.reduce((s, t) => s + (t.creditAmount ?? 0), 0);
  const reviews = txns.filter(isReviewItem);
  const totals = { debit: totalDebits, credit: totalCredits, bankCharges: run.bankChargesTotal };

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

  const expectedClosing = (run.openingBalance ?? 0) + totalCredits - totalDebits;
  const difference = expectedClosing - (run.closingBalance ?? 0);

  const sections: ExportSection[] = [];

  // Cover
  sections.push({
    id: "cover",
    label: "Cover",
    sheet: "Cover",
    rows: [
      [T(packTitle(resolvedCompany))],
      [],
      [B("Company / account holder"), S(resolvedCompany || "Not detected")],
      [B("Bank"), S(run.bank)],
      [B("Account number"), S(run.accountNumber ?? "")],
      [B("Statement period"), S(`${run.statementPeriodStart ?? "?"} to ${run.statementPeriodEnd ?? "?"}`)],
      [B("Transactions"), N(txns.length)],
      [B("Extraction confidence"), S(`${Math.round(run.confidence)}%`)],
      [B("Generated"), S(new Date().toISOString().slice(0, 10))],
      [],
      [B("Disclaimer"), S(DISCLAIMER)],
    ],
  });

  // Summary (Bank Statement)
  sections.push({
    id: "summary",
    label: "Bank Statement Summary",
    sheet: "Summary",
    rows: [
      [B("Metric"), B("Value")],
      [S("Company"), S(resolvedCompany)],
      [S("Account number"), S(run.accountNumber ?? "")],
      [S("Statement period start"), S(run.statementPeriodStart ?? "")],
      [S("Statement period end"), S(run.statementPeriodEnd ?? "")],
      [S("Opening balance"), M(run.openingBalance)],
      [S("Total receipts"), M(totalCredits)],
      [S("Total payments"), M(totalDebits)],
      [S("Closing balance"), M(run.closingBalance)],
      [S("Net movement"), M(totalCredits - totalDebits)],
      [S("Transactions extracted"), N(txns.length)],
      [S("Review items"), N(reviews.length)],
      [S("Bank charges"), M(run.bankChargesTotal)],
    ],
  });

  // Transactions
  sections.push({
    id: "transactions",
    label: "Transactions",
    sheet: "Transactions",
    rows: [
      [B("Date"), B("Description"), B("Money In"), B("Money Out"), B("Balance"), B("Account"), B("VAT Treatment"), B("Review"), B("Confidence"), B("Notes")],
      ...txns.map((t) => [
        S(t.transactionDate ?? ""),
        S(t.description),
        M(t.creditAmount ?? 0),
        M(t.debitAmount ?? 0),
        M(t.runningBalance ?? 0),
        S(t.accountCategory),
        S(VAT_LABELS[t.vatTreatment] ?? t.vatTreatment),
        S(t.reviewStatus),
        N(t.confidence),
        S(t.notes),
      ]),
      [B("Totals"), S(""), M(totalCredits), M(totalDebits), S(""), S(""), S(""), S(""), S(""), S("")],
    ],
  });

  // Review Items
  sections.push({
    id: "review-items",
    label: "Review Items",
    sheet: "Review Items",
    rows: [
      [B("Date"), B("Description"), B("Money In"), B("Money Out"), B("Account"), B("VAT Treatment"), B("Review Status"), B("Confidence"), B("Notes")],
      ...(reviews.length
        ? reviews.map((t) => [
            S(t.transactionDate ?? ""),
            S(t.description),
            M(t.creditAmount ?? 0),
            M(t.debitAmount ?? 0),
            S(t.accountCategory),
            S(VAT_LABELS[t.vatTreatment] ?? t.vatTreatment),
            S(t.reviewStatus),
            N(t.confidence),
            S(t.notes),
          ])
        : [[S("No items require review.")]]),
    ],
  });

  // VAT Schedule (fixes #2)
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
    return [
      S(t.transactionDate ?? ""),
      S(t.description),
      M(t.creditAmount ?? 0),
      M(t.debitAmount ?? 0),
      S(VAT_LABELS[t.vatTreatment] ?? t.vatTreatment),
      M(outputVat),
      M(inputVat),
      M(netVat),
      S(claim),
      S(t.reviewStatus),
    ];
  });
  const totalOutputVat = txns.reduce((s, t) => s + vatForTransaction(t).outputVat, 0);
  const totalInputVat = txns.reduce((s, t) => s + vatForTransaction(t).inputVat, 0);
  sections.push({
    id: "vat",
    label: "VAT Schedule",
    sheet: "VAT Schedule",
    rows: [
      [T("VAT Schedule")],
      [S("VAT estimated at 15% inclusive (15/115) on standard-rated transactions. Verify against SARS VAT201. Not tax advice.")],
      [],
      [B("Est. Output VAT"), M(totalOutputVat), B("Est. Input VAT"), M(totalInputVat), B("Net VAT Position"), M(totalOutputVat - totalInputVat)],
      [],
      [B("Date"), B("Description"), B("Money In"), B("Money Out"), B("VAT Treatment"), B("Output VAT"), B("Input VAT"), B("Net VAT"), B("Claim Status"), B("Review")],
      ...vatDetailRows,
      [B("Totals"), S(""), S(""), S(""), S(""), M(totalOutputVat), M(totalInputVat), M(totalOutputVat - totalInputVat), S(""), S("")],
    ],
  });

  // General Ledger
  const groups = accountGroups(txns);
  sections.push({
    id: "general-ledger",
    label: "General Ledger",
    sheet: "General Ledger",
    rows: [
      [B("Account"), B("Transactions"), B("Debits"), B("Credits"), B("Net Movement")],
      ...groups.map((g) => [S(g.account), N(g.count), M(g.debit), M(g.credit), M(g.credit - g.debit)]),
      [B("Totals"), N(txns.length), M(totalDebits), M(totalCredits), M(totalCredits - totalDebits)],
    ],
  });

  // Trial Balance
  const drTotal = groups.reduce((s, g) => s + Math.max(0, g.debit - g.credit), 0);
  const crTotal = groups.reduce((s, g) => s + Math.max(0, g.credit - g.debit), 0);
  sections.push({
    id: "trial-balance",
    label: "Trial Balance",
    sheet: "Trial Balance",
    rows: [
      [S("Derived from AI-assigned transaction categories. Not a full double-entry trial balance — the bank contra account is not represented.")],
      [],
      [B("Account"), B("Debit Balance"), B("Credit Balance")],
      ...groups.map((g) => {
        const net = g.debit - g.credit;
        return [S(g.account), M(net > 0 ? net : 0), M(net < 0 ? Math.abs(net) : 0)];
      }),
      [B("Totals"), M(drTotal), M(crTotal)],
    ],
  });

  // Bank Reconciliation
  sections.push({
    id: "bank-reconciliation",
    label: "Bank Reconciliation",
    sheet: "Bank Reconciliation",
    rows: [
      [B("Bank Reconciliation"), B("Amount")],
      [S("Opening Balance"), M(run.openingBalance)],
      [S("+ Receipts"), M(totalCredits)],
      [S("- Payments"), M(totalDebits)],
      [S("= Expected Closing Balance"), M(expectedClosing)],
      [S("Statement Closing Balance"), M(run.closingBalance)],
      [S("Difference"), M(difference)],
      [S("Status"), S(Math.abs(difference) < 0.01 ? "Reconciled" : "Review required")],
      [S("Bank charges"), M(run.bankChargesTotal)],
      [S("Bank VAT (15/115)"), M(run.bankChargesTotal * VAT_RATE)],
    ],
  });

  // Profit & Loss
  sections.push({
    id: "profit-loss",
    label: "Profit & Loss",
    sheet: "Profit & Loss",
    rows: [
      [T("Profit & Loss (cash basis)")],
      [S(pl.note)],
      [],
      [B("Income"), B("Count"), B("Amount")],
      ...pl.revenue.map((r) => [S(r.category), N(r.count), M(r.amount)]),
      [B("Total Revenue"), S(""), M(pl.totalRevenue)],
      [],
      [B("Expenses"), B("Count"), B("Amount")],
      ...pl.expenses.map((e) => [S(e.category), N(e.count), M(e.amount)]),
      [B("Total Expenses"), S(""), M(pl.totalExpenses)],
      [],
      [B(pl.netSurplus >= 0 ? "Net Surplus" : "Net Deficit"), S(""), M(pl.netSurplus)],
      [S("Inter-account transfers excluded"), S(""), M(pl.interAccountTransfers)],
    ],
  });

  // Balance Sheet (not fully derivable — explain honestly)
  sections.push({
    id: "balance-sheet",
    label: "Balance Sheet",
    sheet: "Balance Sheet",
    rows: [
      [T("Balance Sheet")],
      [B("Status"), S("Partial — cash position only")],
      [],
      [B("Available from bank data"), B("Amount")],
      [S("Cash at bank (closing balance)"), M(run.closingBalance)],
      [],
      [B("Not available from a single bank statement")],
      [S("Fixed assets, debtors, creditors, inventory, loans, equity and retained earnings")],
      [],
      [B("Data needed for a full balance sheet")],
      [S("General ledger, asset register, accounts receivable/payable, loan schedules and prior-year equity")],
      [],
      [S("No figures are fabricated. A full IFRS balance sheet requires accountant input.")],
    ],
  });

  // Cash Flow
  sections.push({
    id: "cash-flow",
    label: "Cash Flow",
    sheet: "Cash Flow",
    rows: [
      [T("Cash Flow (direct method)")],
      [S(cashFlow.note)],
      [],
      [B("Opening balance"), M(cashFlow.openingBalance)],
      [B("Closing balance"), M(cashFlow.closingBalance)],
      [],
      [B("Inflows"), B("Amount")],
      ...cashFlow.inflows.map((i) => [S(i.label), M(i.amount)]),
      [B("Total inflows"), M(cashFlow.totalInflows)],
      [],
      [B("Outflows"), B("Amount")],
      ...cashFlow.outflows.map((o) => [S(o.label), M(o.amount)]),
      [B("Total outflows"), M(cashFlow.totalOutflows)],
      [],
      [B("Net movement"), M(cashFlow.netMovement)],
      [B("Reconciled"), S(cashFlow.reconciled ? "Yes" : "No — check for missing transactions")],
    ],
  });

  // Financial Statements overview (ratios)
  sections.push({
    id: "financial-statements",
    label: "Financial Ratios",
    sheet: "Financial Ratios",
    rows: [
      [T("Financial Ratios")],
      [S(ratios.note)],
      [],
      [B("Ratio"), B("Value")],
      [S("Expense ratio"), S(ratios.expenseRatio !== null ? `${(ratios.expenseRatio * 100).toFixed(1)}%` : "—")],
      [S("Net cash margin"), S(ratios.netCashMargin !== null ? `${ratios.netCashMargin.toFixed(1)}%` : "—")],
      [S("Cash coverage"), S(ratios.cashCoverageRatio !== null ? `${ratios.cashCoverageRatio.toFixed(2)}x` : "—")],
      [S("Avg monthly income"), M(ratios.avgMonthlyIncome ?? 0)],
      [S("Avg monthly expenses"), M(ratios.avgMonthlyExpenses ?? 0)],
      [S("Net monthly cash flow"), M(ratios.netMonthlyCashFlow ?? 0)],
      [S("Bank charges ratio"), S(ratios.bankChargesRatio !== null ? `${ratios.bankChargesRatio.toFixed(2)}%` : "—")],
      [S("Period (months)"), N(ratios.periodMonths)],
    ],
  });

  // Tax & VAT (anomalies + SARS risk)
  sections.push({
    id: "tax-vat",
    label: "Tax & VAT Intelligence",
    sheet: "Tax & VAT",
    rows: [
      [T("Tax & VAT Intelligence")],
      [B("Internal SARS risk score"), S(`${risk.score}/100 (${risk.level})`)],
      [S(risk.summary)],
      [],
      [B("Risk factor"), B("Score"), B("Max"), B("Detail")],
      ...risk.factors.map((f) => [S(f.name), N(f.score), N(f.maxScore), S(f.detail)]),
      [],
      [B("VAT anomalies"), B("Severity"), B("Amount"), B("Detail")],
      ...(vatAnomalies.length
        ? vatAnomalies.map((a) => [S(a.type), S(a.severity), M(a.amount), S(a.description)])
        : [[S("No VAT anomalies detected.")]]),
      [],
      [S("Internal advisory only. Not a SARS assessment or tax advice.")],
    ],
  });

  // AI Intelligence
  sections.push({
    id: "ai-intelligence",
    label: "AI Intelligence",
    sheet: "AI Intelligence",
    rows: [
      [T("AI Transaction Intelligence")],
      [B(`Duplicate groups: ${duplicates.length}`), B(`Unusual: ${unusuals.length}`), B(`Director-linked: ${directors.length}`)],
      [],
      [B("Potential duplicate payments"), B("Amount"), B("Count"), B("Confidence")],
      ...(duplicates.length
        ? duplicates.map((d) => [S(d.transactions[0]?.description ?? ""), M(d.amount), N(d.transactions.length), S(`${d.confidence}%`)])
        : [[S("No duplicate payments detected.")]]),
      [],
      [B("Unusual transactions"), B("Amount"), B("Reason")],
      ...(unusuals.length
        ? unusuals.map((u) => [S(u.transaction.description), M(u.transaction.debitAmount ?? u.transaction.creditAmount ?? 0), S(u.reason)])
        : [[S("No unusual transactions detected.")]]),
      [],
      [B("Director / related-party"), B("Amount"), B("Matched")],
      ...(directors.length
        ? directors.map((d) => [S(d.transaction.description), M(d.transaction.debitAmount ?? d.transaction.creditAmount ?? 0), S(d.matchedKeyword)])
        : [[S("No director-linked transactions detected.")]]),
    ],
  });

  // Forecasting
  sections.push({
    id: "forecasting",
    label: "Forecasting",
    sheet: "Forecasting",
    rows: [
      [T("Cash Flow Forecast")],
      [S(forecast.note)],
      [],
      [B("Monthly avg income"), M(forecast.monthlyAvgIncome)],
      [B("Monthly avg expenses"), M(forecast.monthlyAvgExpenses)],
      [B("Monthly net flow"), M(forecast.monthlyNetFlow)],
      [],
      [B("Month"), B("Projected Income"), B("Projected Expenses"), B("Net Flow"), B("Closing Balance")],
      ...forecast.projections.map((p) => [S(p.label), M(p.projectedIncome), M(p.projectedExpenses), M(p.projectedNetFlow), M(p.projectedClosingBalance)]),
    ],
  });

  // Audit Tools
  sections.push({
    id: "audit-tools",
    label: "Audit Tools",
    sheet: "Audit Tools",
    rows: [
      [T("Audit Pack")],
      [B("Risk"), S(`${audit.riskScore.score}/100 (${audit.riskScore.level})`)],
      [B("Review items"), N(audit.reviewItems)],
      [B("Uncategorised"), N(audit.uncategorized)],
      [B("Payments >R5k without invoice"), N(audit.transactionsNeedingInvoice.length)],
      [],
      [B("Finding"), B("Severity"), B("Category"), B("Detail")],
      ...(audit.findings.length
        ? audit.findings.map((f) => [S(f.title), S(f.severity), S(f.category), S(f.detail)])
        : [[S("No audit findings. Statement appears complete and well-classified.")]]),
    ],
  });

  // Assumptions / Limitations
  sections.push({
    id: "assumptions",
    label: "Assumptions & Limitations",
    sheet: "Assumptions",
    rows: [
      [T("Assumptions & Limitations")],
      [S(DISCLAIMER)],
      [],
      [B("Module"), B("Status"), B("Notes")],
      [S("Profit & Loss"), S("Cash basis"), S("Excludes accruals, depreciation, prepayments and capital items.")],
      [S("Balance Sheet"), S("Partial"), S("Cash position only. Full statement needs GL, assets, liabilities, equity.")],
      [S("Cash Flow"), S("Direct method"), S("Investing/financing activities not separately classified.")],
      [S("VAT"), S("Estimated"), S("15% inclusive on standard-rated lines. Verify against tax invoices and VAT201.")],
      [S("SARS Risk"), S("Advisory"), S("Internal 0–100 score. Not a SARS assessment or tax advice.")],
      [S("Forecasting"), S(forecast.periodMonths <= 1 ? "Single period" : "Multi-period"), S("Assumes consistent patterns; process more statements to improve.")],
      [S("Trial Balance"), S("Indicative"), S("Not double-entry; bank contra account not represented.")],
    ],
  });

  return sections;
}

// ─── CSV renderer ───────────────────────────────────────────────────────────

function csvCell(cell: Cell): string {
  const text = cell.k === "n" ? String(cell.v) : cell.v;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function sectionToCsv(section: ExportSection): string {
  return section.rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

// ─── XLSX renderer (multi-sheet, styled, red negatives) ─────────────────────

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
  let base = name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31).trim() || "Sheet";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    base = name.slice(0, 28);
    candidate = `${base} ${i}`;
    i += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// Style indices in styles.xml below:
//   0 plain, 1 bold, 2 title (bold white on dark fill), 3 money (red negatives)
const STYLE = { plain: 0, bold: 1, title: 2, money: 3 } as const;

function cellXml(cell: Cell, ref: string): string {
  if (cell.k === "n") {
    const style = cell.money ? STYLE.money : STYLE.plain;
    const v = Number.isFinite(cell.v) ? cell.v : 0;
    return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
  }
  const style = cell.style === "bold" ? STYLE.bold : cell.style === "title" ? STYLE.title : STYLE.plain;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.v)}</t></is></c>`;
}

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row.map((cell, c) => cellXml(cell, `${colLetter(c)}${r + 1}`)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

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
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: encoder.encode(sheetXml(s.rows)) })),
  ];

  return createZip(entries);
}
