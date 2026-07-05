import { createZip } from "@/lib/file-output";
import type { AccountingRunDetail, AccountingTransaction } from "@/lib/accounting/types";
import {
  computeProfitLoss,
  detectDuplicates,
  detectDirectorTransactions,
  detectUnusualTransactions,
  accountType,
  type AccountType,
} from "@/lib/accounting/analytics";
import { buildAccountingModel } from "@/lib/accounting/model";

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

export type ExportSectionId =
  | "cover"
  | "summary"
  | "transactions"
  | "review-queue"
  | "vat"
  | "general-ledger"
  | "trial-balance"
  | "profit-loss"
  | "balance-sheet"
  | "cash-flow"
  | "bank-reconciliation"
  | "transaction-insights"
  | "assumptions";

export type ExportSection = {
  id: ExportSectionId;
  label: string;
  sheet: string;
  rows: Cell[][];
  headerRow?: number; // 1-based; freezes rows above+including and enables filter
  filter?: boolean;
};

// The professional accounting pack — the ONLY sheets in the full workbook, in
// order. Shared by the export route and the modal so they never drift.
export const FULL_PACK_SECTIONS: ExportSectionId[] = [
  "cover",
  "summary",
  "transactions",
  "review-queue",
  "vat",
  "general-ledger",
  "trial-balance",
  "profit-loss",
  "balance-sheet",
  "cash-flow",
  "bank-reconciliation",
  "assumptions",
];

// The individually downloadable exports shown in the modal (label → section id).
export const EXPORT_MENU: Array<{ key: string; label: string; section: ExportSectionId | "all" }> = [
  { key: "all", label: "Full Accounting Pack", section: "all" },
  { key: "transactions", label: "Transactions", section: "transactions" },
  { key: "summary", label: "Executive Summary", section: "summary" },
  { key: "vat", label: "VAT Working Paper", section: "vat" },
  { key: "general-ledger", label: "General Ledger", section: "general-ledger" },
  { key: "trial-balance", label: "Trial Balance", section: "trial-balance" },
  { key: "profit-loss", label: "Profit & Loss", section: "profit-loss" },
  { key: "balance-sheet", label: "Balance Sheet", section: "balance-sheet" },
  { key: "cash-flow", label: "Cash Flow", section: "cash-flow" },
  { key: "bank-reconciliation", label: "Bank Reconciliation", section: "bank-reconciliation" },
  { key: "review-queue", label: "Review Queue", section: "review-queue" },
  { key: "transaction-insights", label: "Transaction Insights Report", section: "transaction-insights" },
];

const VAT_RATE = 15 / 115;

const DISCLAIMER =
  "Draft management report prepared from bank-statement data only. This is not a final IFRS or Companies Act financial statement and requires accountant review. No figures are fabricated — sections without sufficient underlying data are marked accordingly.";

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

// Group by the real account/category so the General Ledger and Trial Balance
// reflect actual accounts. Only genuinely-unknown categories collapse into the
// suspense account — everything else keeps its own ledger line.
function accountGroups(transactions: AccountingTransaction[]) {
  const groups = new Map<string, { debit: number; credit: number; count: number; type: AccountType }>();
  for (const t of transactions) {
    const type = accountType(t.accountCategory);
    const account = type === "suspense" ? "Review Required Suspense" : t.accountCategory || "Uncategorised";
    const current = groups.get(account) ?? { debit: 0, credit: 0, count: 0, type };
    current.debit += t.debitAmount ?? 0;
    current.credit += t.creditAmount ?? 0;
    current.count += 1;
    groups.set(account, current);
  }
  return Array.from(groups, ([account, v]) => ({ account, ...v })).sort((a, b) => a.account.localeCompare(b.account));
}

// ─── Section builders ───────────────────────────────────────────────────────

export function buildExportSections(detail: AccountingRunDetail, resolvedCompany: string): ExportSection[] {
  const meta = buildStatementMetadata(detail, resolvedCompany);
  const txns = detail.transactions;
  const run = detail.run;

  // ONE canonical accounting model — every ledger-based sheet consumes this.
  const model = buildAccountingModel(detail);

  const pl = computeProfitLoss(txns, run);
  const duplicates = detectDuplicates(txns);
  const directors = detectDirectorTransactions(txns);

  const sections: ExportSection[] = [];

  // When the statement does not reconcile, extraction is incomplete and every
  // derived statement must be watermarked as unreliable — never silently shown.
  const unreliableBanner: Cell[] | null = meta.reconciled
    ? null
    : [WARN("REVIEW REQUIRED — the statement does not reconcile, so figures may be incomplete. Do not use for filing until resolved. See Executive Summary.")];

  // Status badge: Complete / Review Required / Unable to Verify.
  const dataQualityStatus = meta.reconciled ? "Complete" : meta.closingBalance === 0 && meta.openingBalance === 0 ? "Unable to Verify" : "Review Required";
  const statusCell = dataQualityStatus === "Complete" ? GOOD(dataQualityStatus) : WARN(dataQualityStatus);

  // Cover
  sections.push({
    id: "cover",
    label: "Cover",
    sheet: "Cover",
    rows: [
      [TITLE(meta.title)],
      [],
      meta.reconciled
        ? [GOOD("Status: Complete — the statement reconciles.")]
        : [WARN(`Status: Review Required — reconciliation difference of R${Math.abs(meta.reconciliationDifference).toFixed(2)}. See Executive Summary.`)],
      [],
      [B("Company / account holder"), S(meta.company || "Not detected")],
      [B("Bank"), S(meta.bank)],
      [B("Account number"), S(meta.accountNumber)],
      [B("Statement period"), S(meta.statementPeriod)],
      [B("Opening balance"), M(meta.openingBalance)],
      [B("Closing balance"), M(meta.closingBalance)],
      [B("Total receipts"), M(meta.totalReceipts)],
      [B("Total payments"), M(meta.totalPayments)],
      [B("Transactions processed"), INT(meta.transactionCount)],
      [B("Items requiring review"), INT(meta.reviewCount)],
      [B("Prepared"), S(new Date().toISOString().slice(0, 10))],
      [],
      [MUTE(DISCLAIMER)],
    ],
  });

  // Executive Summary — the accountant's dashboard (includes data quality).
  sections.push({
    id: "summary",
    label: "Executive Summary",
    sheet: "Summary",
    headerRow: 3,
    rows: [
      [TITLE("Executive Summary")],
      [],
      [HDR("Metric"), HDR("Value")],
      [S("Company"), S(meta.company)],
      [S("Statement period"), S(meta.statementPeriod)],
      [S("Bank"), S(meta.bank)],
      [S("Account number"), S(meta.accountNumber)],
      [S("Transactions processed"), INT(meta.transactionCount)],
      [S("Reconciliation status"), meta.reconciled ? GOOD("Reconciled") : WARN("Review Required")],
      [],
      [B("Income (receipts)"), MT(meta.totalReceipts)],
      [B("Expenses (payments)"), MT(meta.totalPayments)],
      [B("Net cash movement"), meta.totalReceipts - meta.totalPayments >= 0 ? MT(meta.totalReceipts - meta.totalPayments) : MW(meta.totalReceipts - meta.totalPayments)],
      [S("Opening balance"), M(meta.openingBalance)],
      [S("Closing balance"), M(meta.closingBalance)],
      [S("Bank charges"), M(meta.bankCharges)],
      [],
      [HDR("VAT summary"), HDR("Amount")],
      [S("Output VAT"), M(meta.estOutputVat)],
      [S("Input VAT"), M(meta.estInputVat)],
      [S("Net VAT position"), M(meta.netVat)],
      [],
      [B("Items requiring review"), meta.reviewCount === 0 ? GOOD("0") : WARN(String(meta.reviewCount))],
      [B("Data quality status"), statusCell],
      ...(meta.reconciled ? [] : [[MUTE(`Reconciliation difference of R${Math.abs(meta.reconciliationDifference).toFixed(2)} — resolve before relying on the financial statements.`)]]),
    ],
  });

  // Transactions — the master working paper (no engine/AI columns).
  sections.push({
    id: "transactions",
    label: "Transactions",
    sheet: "Transactions",
    headerRow: 1,
    filter: true,
    rows: [
      [HDR("Date"), HDR("Reference"), HDR("Description"), HDR("Debit"), HDR("Credit"), HDR("Balance"), HDR("Category"), HDR("GL Account"), HDR("VAT Code"), HDR("Review Status"), HDR("Notes")],
      ...model.transactions.map((t) => [
        S(t.date),
        S(t.reference),
        S(t.description),
        M(t.debit),
        M(t.credit),
        t.balance != null ? M(t.balance) : S(""),
        S(t.category),
        S(t.account.number),
        t.vatCode === "REV" ? WARN(t.vatCode) : S(t.vatCode),
        t.reviewReason ? WARN(t.reviewStatus) : S(t.reviewStatus),
        S(t.notes),
      ]),
      [B("Totals"), S(""), S(""), MT(meta.totalPayments), MT(meta.totalReceipts), S(""), S(""), S(""), S(""), S(""), S("")],
    ],
  });

  // VAT Working Paper — professional, every VAT amount traces to a transaction.
  const v201 = model.vat201;
  const claimStatusOf = (t: (typeof model.transactions)[number]) =>
    t.vatCode === "REV"
      ? "Review required"
      : t.vatCode === "STD"
        ? t.debit > 0
          ? t.supportedByInvoice
            ? "Claimable (invoice on file)"
            : "Invoice required"
          : "Output VAT"
        : t.vatTreatmentLabel;
  // Declared bank VAT from the statement's fee summary (e.g. R158.64). If the
  // fee rows were extracted per-transaction their input VAT is already counted;
  // otherwise the shortfall is added so declared bank VAT is never lost.
  const bankChargeInputVat = model.transactions.filter((t) => t.bankCharge).reduce((s, t) => s + t.inputVat, 0);
  const declaredBankVat = meta.bankCharges * VAT_RATE;
  const supplementaryBankVat = Math.max(0, declaredBankVat - bankChargeInputVat);
  const totalInputVat = v201.inputVat + supplementaryBankVat;
  const totalNetVat = v201.outputVat - totalInputVat;
  sections.push({
    id: "vat",
    label: "VAT Working Paper",
    sheet: "VAT Working Paper",
    headerRow: 8,
    filter: true,
    rows: [
      [TITLE("VAT Working Paper & VAT201")],
      [MUTE("VAT estimated at 15% inclusive (15/115). Every amount traces to a transaction. Verify against valid tax invoices and SARS VAT201. Not tax advice.")],
      [],
      [HDR("Estimated VAT201"), HDR("Output VAT"), HDR("Input VAT"), HDR("Declared Bank VAT"), HDR("Net VAT"), HDR("Review Items"), HDR("Missing Invoices")],
      [S("Totals"), M(v201.outputVat), M(totalInputVat), M(declaredBankVat), M(totalNetVat), INT(v201.reviewItems), INT(v201.missingInvoices)],
      [],
      [HDR("Date"), HDR("Reference"), HDR("Description"), HDR("Debit"), HDR("Credit"), HDR("Category"), HDR("GL Account"), HDR("VAT Code"), HDR("VAT %"), HDR("Input VAT"), HDR("Output VAT"), HDR("Net VAT"), HDR("VAT201 Box"), HDR("Claim Status"), HDR("Review Status"), HDR("Notes")],
      ...model.transactions.map((t) => [
        S(t.date),
        S(t.reference),
        S(t.description),
        M(t.debit),
        M(t.credit),
        S(t.category),
        S(t.account.number),
        t.vatCode === "REV" ? WARN(t.vatCode) : t.vatCode === "STD" ? S(t.vatCode) : MUTE(t.vatCode),
        S(t.vatCode === "STD" ? "15%" : t.vatCode === "ZR" ? "0%" : "—"),
        M(t.inputVat),
        M(t.outputVat),
        t.netVat < 0 ? MW(t.netVat) : M(t.netVat),
        S(t.sarsBox),
        S(claimStatusOf(t)),
        t.reviewReason ? WARN(t.reviewStatus) : S(t.reviewStatus),
        S(t.notes),
      ]),
      ...(supplementaryBankVat > 0.005
        ? [[B("Declared bank VAT (fees not itemised)"), S(""), S(""), S(""), S(""), S("Bank Charges"), S("5000"), S("STD"), S("15%"), M(supplementaryBankVat), M(0), M(-supplementaryBankVat), S("14/15 (Input VAT)"), S("Input VAT"), WARN("needs_review"), S("From statement fee summary")]]
        : []),
      [B("Totals"), S(""), S(""), MT(meta.totalPayments), MT(meta.totalReceipts), S(""), S(""), S(""), S(""), MT(totalInputVat), MT(v201.outputVat), MT(totalNetVat), S(""), S(""), S(""), S("")],
      [],
      [TITLE("Estimated SARS VAT201")],
      [HDR("VAT201 Box"), HDR("Description"), HDR("Amount")],
      [S("1"), S("Standard-rate supplies (output)"), M(v201.standardSupplies)],
      [S("2"), S("Zero-rated supplies"), M(v201.zeroRated)],
      [S("3"), S("Exempt / non-supplies"), M(v201.exempt)],
      [S("4"), S("Output VAT"), M(v201.outputVat)],
      [S("14/15"), S("Input VAT (incl. declared bank VAT)"), M(totalInputVat)],
      [B("13"), B(totalNetVat >= 0 ? "Net VAT payable" : "Net VAT refundable"), totalNetVat >= 0 ? MT(totalNetVat) : MW(totalNetVat)],
    ],
  });

  // General Ledger
  const groups = accountGroups(txns);
  // Aggregate ledger accounts by account type for the Balance Sheet and Cash Flow.
  const typeGroups = new Map<AccountType, { debit: number; credit: number }>();
  for (const g of groups) {
    const e = typeGroups.get(g.type) ?? { debit: 0, credit: 0 };
    e.debit += g.debit;
    e.credit += g.credit;
    typeGroups.set(g.type, e);
  }
  const tg = (type: AccountType) => typeGroups.get(type) ?? { debit: 0, credit: 0 };

  // General Ledger — a professional running-balance ledger of the account
  // postings (bank account is the contra to every line).
  let glBalance = meta.openingBalance;
  sections.push({
    id: "general-ledger",
    label: "General Ledger",
    sheet: "General Ledger",
    headerRow: 2,
    filter: true,
    rows: [
      [S("Opening balance"), S(""), S(""), S(""), S(""), S(""), M(meta.openingBalance), S("")],
      [HDR("Date"), HDR("Reference"), HDR("Description"), HDR("Account"), HDR("Debit"), HDR("Credit"), HDR("Running Balance"), HDR("Review Status")],
      ...model.transactions.map((t) => {
        glBalance += t.credit - t.debit;
        return [
          S(t.date),
          S(t.reference),
          S(t.description),
          S(t.account.name),
          t.debit > 0 ? M(t.debit) : S(""),
          t.credit > 0 ? M(t.credit) : S(""),
          M(glBalance),
          t.reviewReason ? WARN(t.reviewStatus) : S(t.reviewStatus),
        ];
      }),
      [B("Totals"), S(""), S(""), S(""), MT(meta.totalPayments), MT(meta.totalReceipts), MT(meta.closingBalance), S("")],
    ],
  });

  // Trial Balance — from the ledger accounts, with a variance and status.
  const tb = model.trialBalance;
  sections.push({
    id: "trial-balance",
    label: "Trial Balance",
    sheet: "Trial Balance",
    headerRow: 3,
    filter: true,
    rows: [
      meta.reconciled
        ? [MUTE("Trial balance derived from the general ledger. Requires accountant review.")]
        : [WARN("REVIEW REQUIRED — the statement does not reconcile, so the underlying data is incomplete. Do not rely on this trial balance until resolved.")],
      [],
      [HDR("Account"), HDR("Debit"), HDR("Credit"), HDR("Variance"), HDR("Status")],
      ...tb.rows.map((r) => [S(r.name), M(r.debit), M(r.credit), M(0), meta.reconciled ? GOOD("OK") : WARN("Review")]),
      [B("Totals"), MT(tb.totalDebit), MT(tb.totalCredit), M(tb.totalDebit - tb.totalCredit), meta.reconciled ? (tb.balanced ? GOOD("Balanced") : WARN("Out of balance")) : WARN("REVIEW REQUIRED")],
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

  // (Reconciliation detail is surfaced on the Executive Summary and Bank
  // Reconciliation sheets — no separate sheet.)

  // Profit & Loss
  sections.push({
    id: "profit-loss",
    label: "Profit & Loss",
    sheet: "Profit & Loss",
    headerRow: 4,
    rows: [
      [TITLE("Profit & Loss (cash basis)")],
      ...(unreliableBanner ? [unreliableBanner] : []),
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
      [],
      [HDR("Excluded from P&L (balance sheet / suspense / review)"), HDR("Count"), HDR("Movement")],
      ...(pl.excluded.length
        ? pl.excluded.map((e) => [MUTE(e.category), INT(e.count), M(e.amount)])
        : [[MUTE("None"), S(""), M(0)]]),
      [MUTE("Inter-account transfers excluded"), S(""), M(pl.interAccountTransfers)],
      [MUTE("Tax, director loans, loans, refunds and unclassified items are excluded from profit and shown on the Balance Sheet / Suspense.")],
    ],
  });

  // Balance Sheet (partial — cash + detected movements, nothing fabricated)
  const directorNet = tg("director_loan").debit - tg("director_loan").credit; // debit = paid to director
  const taxNet = tg("tax").credit - tg("tax").debit;
  const loanNet = tg("loan").credit - tg("loan").debit; // credit = loan received (liability up)
  const refundNet = tg("refund").debit - tg("refund").credit;
  sections.push({
    id: "balance-sheet",
    label: "Balance Sheet",
    sheet: "Balance Sheet",
    headerRow: 4,
    rows: [
      [TITLE("Balance Sheet (partial — bank-statement derived)")],
      ...(unreliableBanner ? [unreliableBanner] : []),
      [WARN("Cash position plus balance-sheet movements detected on the statement. Not a complete IFRS balance sheet.")],
      [],
      [HDR("Item"), HDR("Amount (period movement)"), HDR("Note")],
      [B("Cash at bank (closing balance)"), M(meta.closingBalance), S("From the statement")],
      [S("Director loan / drawings movement"), M(directorNet), MUTE("Requires accountant review — asset/receivable or drawings")],
      [S("Tax / SARS suspense movement"), M(taxNet), MUTE("Requires review — liability or asset, confirm with SARS")],
      [S("Loan / finance movement"), M(loanNet), MUTE("Requires review — loan liability")],
      [S("Refund / suspense movement"), M(refundNet), MUTE("Requires review — contra / to be matched")],
      [],
      [B("Not available from a single bank statement")],
      [MUTE("Fixed assets, debtors, creditors, inventory, equity and retained earnings")],
      [B("Data needed for a full balance sheet")],
      [MUTE("General ledger, asset register, accounts receivable/payable, loan schedules and prior-year equity")],
      [],
      [MUTE("No figures are fabricated — only movements observed on the statement are shown, all flagged for accountant review.")],
    ],
  });

  // Cash Flow — grouped by activity so balance-sheet movements are not shown as
  // operating income/expense. Net of all sections must reconcile opening→closing.
  const operatingIn = tg("revenue").credit;
  const operatingOut = tg("expense").debit + tg("bank_charges").debit;
  const netFor = (type: AccountType) => tg(type).credit - tg(type).debit;
  const cashSections: Array<[string, number]> = [
    ["Operating inflows (revenue)", operatingIn],
    ["Operating outflows (expenses & bank charges)", -operatingOut],
    ["Owner / director movements", netFor("director_loan")],
    ["Tax / SARS movements", netFor("tax")],
    ["Loan / finance movements", netFor("loan")],
    ["Transfers", netFor("transfer")],
    ["Refunds / suspense / review", netFor("refund") + netFor("suspense")],
  ];
  const netMovement = cashSections.reduce((s, [, amt]) => s + amt, 0);
  const expectedClose = (meta.openingBalance ?? 0) + netMovement;
  const cashReconciled = Math.abs(expectedClose - (meta.closingBalance ?? expectedClose)) < 0.02;
  sections.push({
    id: "cash-flow",
    label: "Cash Flow",
    sheet: "Cash Flow",
    headerRow: 4,
    rows: [
      [TITLE("Cash Flow (direct method, by activity)")],
      ...(cashReconciled ? [] : [[WARN("INVALID / REVIEW REQUIRED — cash flow does not tie to the bank balance; extraction is incomplete.")]]),
      [MUTE("Movements grouped by activity. Balance-sheet items (tax, loans, director, transfers) are shown separately from operating cash flow. Net of all sections reconciles the bank balance.")],
      [],
      [HDR("Activity"), HDR("Net Cash")],
      ...cashSections.map(([label, amount]) => [S(label), amount < 0 ? MW(amount) : M(amount)]),
      [B("Net movement"), MT(netMovement)],
      [],
      [B("Opening balance"), M(meta.openingBalance)],
      [B("+ Net movement"), MT(netMovement)],
      [B("= Expected closing"), MT(expectedClose)],
      [B("Statement closing balance"), M(meta.closingBalance)],
      [B("Reconciled"), cashReconciled ? GOOD("Yes — cash flow ties to the bank balance") : WARN("No — review required; see Executive Summary")],
    ],
  });

  // Review Queue — the accountant's action list: exception flags at the top, then
  // every transaction needing attention. No engine/AI columns.
  const exceptions: Cell[][] = [];
  if (!meta.reconciled) exceptions.push([WARN("Reconciliation"), MW(meta.reconciliationDifference), S("Statement does not reconcile — figures may be incomplete")]);
  if (duplicates.length) exceptions.push([WARN("Possible duplicate"), INT(duplicates.length), S("Potential duplicate payment groups")]);
  if (v201.missingInvoices) exceptions.push([WARN("Missing invoice"), INT(v201.missingInvoices), S("Standard-rated payments without a tax invoice")]);
  if (directors.length) exceptions.push([WARN("Related party"), INT(directors.length), S("Director or related-party movements to confirm")]);
  const largeCount = model.transactions.filter((t) => (t.debit || t.credit) >= 25000).length;
  if (largeCount) exceptions.push([WARN("Large transaction"), INT(largeCount), S("Transactions of R25,000 or more")]);

  const rowReason = (t: (typeof model.transactions)[number]): string => {
    const reasons: string[] = [];
    if (t.reviewReason) reasons.push(t.reviewReason);
    if ((t.debit || t.credit) >= 25000) reasons.push("Large transaction");
    if (t.vatCode === "STD" && t.debit > 0 && !t.supportedByInvoice) reasons.push("Missing invoice");
    return reasons.join("; ") || "Requires review";
  };
  const reviewQueue = model.transactions.filter(
    (t) => t.reviewReason || t.reviewStatus === "needs_review" || t.reviewStatus === "in_review" || (t.debit || t.credit) >= 25000,
  );
  sections.push({
    id: "review-queue",
    label: "Review Queue",
    sheet: "Review Queue",
    headerRow: 4,
    filter: reviewQueue.length > 0,
    rows: [
      [TITLE("Review Queue")],
      [MUTE("Items requiring accountant attention before finalising.")],
      [HDR("Flag"), HDR("Count / Amount"), HDR("Detail")],
      ...(exceptions.length ? exceptions : [[GOOD("No exceptions detected."), S(""), S("")]]),
      [],
      [HDR("Date"), HDR("Reference"), HDR("Description"), HDR("Amount"), HDR("Category"), HDR("VAT Code"), HDR("Review Reason")],
      ...(reviewQueue.length
        ? reviewQueue.map((t) => [
            S(t.date),
            S(t.reference),
            S(t.description),
            M(t.debit || t.credit),
            S(t.category),
            t.vatCode === "REV" ? WARN(t.vatCode) : S(t.vatCode),
            WARN(rowReason(t)),
          ])
        : [[GOOD("Nothing to review — all transactions are categorised with resolved VAT."), S(""), S(""), S(""), S(""), S(""), S("")]]),
    ],
  });

  // Transaction Insights Report — a standalone review report: duplicates,
  // unusual activity, related-party/director movements, large transactions,
  // unresolved review items, VAT review items, reconciliation issues and notes.
  // No internal/AI wording — presented as professional review insights.
  const unusual = detectUnusualTransactions(txns);
  const largeTxns = model.transactions.filter((t) => (t.debit || t.credit) >= 25000);
  const vatReview = model.transactions.filter((t) => t.vatCode === "REV");
  const unresolvedItems = model.transactions.filter((t) => t.reviewReason);
  const insightsRows: Cell[][] = [
    [TITLE("Transaction Insights Report")],
    [MUTE("Review insights compiled from the extracted statement data. For accountant review — verify before finalising.")],
    [],
    [HDR("Insight"), HDR("Count"), HDR("Detail")],
    [S("Duplicate payment groups"), duplicates.length ? WARN(String(duplicates.length)) : GOOD("0"), S("Same amount and date appearing more than once")],
    [S("Unusual transactions"), unusual.length ? WARN(String(unusual.length)) : GOOD("0"), S("Amounts well outside the typical range")],
    [S("Related-party / director activity"), directors.length ? WARN(String(directors.length)) : GOOD("0"), S("Payments to owners or related parties to confirm")],
    [S("Large transactions"), largeTxns.length ? WARN(String(largeTxns.length)) : GOOD("0"), S("Transactions of R25,000 or more")],
    [S("Unresolved review items"), unresolvedItems.length ? WARN(String(unresolvedItems.length)) : GOOD("0"), S("Transactions still needing a decision")],
    [S("VAT review items"), vatReview.length ? WARN(String(vatReview.length)) : GOOD("0"), S("VAT treatment not yet resolved")],
    [S("Reconciliation"), meta.reconciled ? GOOD("Balanced") : WARN("Review Required"), meta.reconciled ? S("Statement reconciles") : MW(meta.reconciliationDifference)],
    [],
    [TITLE("Duplicate payment groups")],
    [HDR("Description"), HDR("Amount"), HDR("Occurrences")],
    ...(duplicates.length
      ? duplicates.map((d) => [S(d.transactions[0]?.description ?? "—"), M(d.amount), INT(d.transactions.length)])
      : [[GOOD("No duplicate payments detected."), S(""), S("")]]),
    [],
    [TITLE("Unusual transactions")],
    [HDR("Date"), HDR("Description"), HDR("Amount"), HDR("Reason")],
    ...(unusual.length
      ? unusual.map((u) => [S(u.transaction.transactionDate ?? ""), S(u.transaction.description), M(u.transaction.debitAmount ?? u.transaction.creditAmount ?? 0), S(u.reason)])
      : [[GOOD("No unusual transactions detected."), S(""), S(""), S("")]]),
    [],
    [TITLE("Related-party & director activity")],
    [HDR("Date"), HDR("Description"), HDR("Amount")],
    ...(directors.length
      ? directors.map((d) => [S(d.transaction.transactionDate ?? ""), S(d.transaction.description), M(d.transaction.debitAmount ?? d.transaction.creditAmount ?? 0)])
      : [[GOOD("No related-party or director activity detected."), S(""), S("")]]),
    [],
    [TITLE("Large transactions")],
    [HDR("Date"), HDR("Description"), HDR("Amount")],
    ...(largeTxns.length
      ? largeTxns.map((t) => [S(t.date), S(t.description), M(t.debit || t.credit)])
      : [[GOOD("No large transactions detected."), S(""), S("")]]),
    [],
    [TITLE("Unresolved review items")],
    [HDR("Date"), HDR("Description"), HDR("Reason")],
    ...(unresolvedItems.length
      ? unresolvedItems.map((t) => [S(t.date), S(t.description), S(t.reviewReason)])
      : [[GOOD("Nothing outstanding."), S(""), S("")]]),
    [],
    [TITLE("Summary notes")],
    [MUTE(
      meta.reconciled
        ? `Statement reconciles. ${unresolvedItems.length} item(s) flagged for review, ${vatReview.length} with unresolved VAT.`
        : `Statement does not reconcile (difference R${Math.abs(meta.reconciliationDifference).toFixed(2)}). Resolve the flagged items and re-check before relying on the financial statements.`,
    )],
  ];
  sections.push({
    id: "transaction-insights",
    label: "Transaction Insights Report",
    sheet: "Transaction Insights",
    headerRow: 4,
    rows: insightsRows,
  });

  // Notes & Assumptions — the single closing worksheet: accounting notes,
  // outstanding review items, reconciliation comments and a source appendix.
  const uncategorised = txns.filter((t) => /uncategori|review required|operating expenses/i.test(t.accountCategory)).length;
  const withoutInvoice = txns.filter((t) => (t.debitAmount ?? 0) > 5000 && !t.supportedByInvoice && !t.bankCharge).length;
  sections.push({
    id: "assumptions",
    label: "Notes & Assumptions",
    sheet: "Notes & Assumptions",
    headerRow: 3,
    rows: [
      [TITLE("Notes & Assumptions")],
      [MUTE(DISCLAIMER)],
      [HDR("Basis of preparation"), HDR("Note")],
      [S("Profit & Loss"), MUTE("Cash basis. Excludes accruals, depreciation, prepayments and capital items.")],
      [S("Balance Sheet"), MUTE("Cash position plus movements observed on the statement. Not a complete IFRS balance sheet.")],
      [S("Cash Flow"), MUTE("Direct method. Operating, tax, financing and owner movements shown separately.")],
      [S("VAT"), MUTE("15% inclusive on standard-rated lines. Verify against valid tax invoices and SARS VAT201.")],
      [S("Trial Balance"), MUTE("Derived from the general ledger. Requires accountant review before posting.")],
      [],
      [HDR("Outstanding review items"), HDR("Count")],
      [S("Items requiring review"), meta.reviewCount === 0 ? GOOD("0") : WARN(String(meta.reviewCount))],
      [S("Uncategorised"), uncategorised === 0 ? GOOD("0") : WARN(String(uncategorised))],
      [S("Payments over R5,000 without an invoice"), withoutInvoice === 0 ? GOOD("0") : WARN(String(withoutInvoice))],
      [],
      [HDR("Reconciliation"), HDR("Result")],
      [S("Opening + receipts − payments = closing"), meta.reconciled ? GOOD("Reconciled") : WARN("Review Required")],
      ...(meta.reconciled ? [] : [[S("Difference"), MW(meta.reconciliationDifference)]]),
      [],
      [HDR("Statement details"), HDR("Value")],
      [S("Bank"), S(meta.bank)],
      [S("Statement type"), S(run.statementType)],
      [S("Company (as read)"), S(meta.company || "Not detected")],
      [S("Account number (as read)"), S(meta.accountNumber || "Not detected")],
      [S("Statement period"), S(meta.statementPeriod)],
      [S("Opening balance"), M(meta.openingBalance)],
      [S("Closing balance"), M(meta.closingBalance)],
      [S("Transactions processed"), INT(meta.transactionCount)],
      [S("Prepared"), S(new Date().toISOString().slice(0, 10))],
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
