import type { AccountingRunDetail, AccountingTransaction } from "@/lib/accounting/types";
import { accountType, type AccountType } from "@/lib/accounting/analytics";

// ─────────────────────────────────────────────────────────────────────────────
// ONE canonical accounting model. Bank statement → validated transactions →
// chart of accounts → double-entry journals → general ledger → trial balance →
// financial statements → VAT. Every worksheet consumes THIS model, so nothing is
// recomputed independently and one transaction change flows to every report.
// ─────────────────────────────────────────────────────────────────────────────

const VAT_RATE = 15 / 115;

export type AccountGroup = "asset" | "liability" | "equity" | "revenue" | "expense";
export type StatementSide = "balance_sheet" | "profit_loss";

export type ChartAccount = {
  number: string;
  name: string;
  type: AccountType | "bank" | "vat";
  group: AccountGroup;
  statement: StatementSide;
};

// Standard chart of accounts (Big-Four style numbering).
export const CHART: ChartAccount[] = [
  { number: "1000", name: "Cash at Bank", type: "bank", group: "asset", statement: "balance_sheet" },
  { number: "1200", name: "VAT Control", type: "vat", group: "asset", statement: "balance_sheet" },
  { number: "1300", name: "Loan Receivable", type: "loan", group: "asset", statement: "balance_sheet" },
  { number: "2000", name: "Loans", type: "loan", group: "liability", statement: "balance_sheet" },
  { number: "2100", name: "SARS / Tax Liability", type: "tax", group: "liability", statement: "balance_sheet" },
  { number: "2200", name: "VAT Payable", type: "vat", group: "liability", statement: "balance_sheet" },
  { number: "2300", name: "Director Loan / Drawings", type: "director_loan", group: "liability", statement: "balance_sheet" },
  { number: "2900", name: "Suspense / Review Required", type: "suspense", group: "liability", statement: "balance_sheet" },
  { number: "2910", name: "Refund Suspense", type: "refund", group: "liability", statement: "balance_sheet" },
  { number: "2920", name: "Inter-account Transfers", type: "transfer", group: "liability", statement: "balance_sheet" },
  { number: "3000", name: "Capital", type: "revenue", group: "equity", statement: "balance_sheet" },
  { number: "3100", name: "Retained Earnings", type: "revenue", group: "equity", statement: "balance_sheet" },
  { number: "4000", name: "Sales / Revenue", type: "revenue", group: "revenue", statement: "profit_loss" },
  { number: "4100", name: "Interest Received", type: "revenue", group: "revenue", statement: "profit_loss" },
  { number: "4200", name: "Revenue Review", type: "revenue", group: "revenue", statement: "profit_loss" },
  { number: "4300", name: "Cash Deposits (Review)", type: "revenue", group: "revenue", statement: "profit_loss" },
  { number: "5000", name: "Bank Charges", type: "bank_charges", group: "expense", statement: "profit_loss" },
  { number: "5100", name: "Motor Vehicle Expenses", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5200", name: "Communication", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5300", name: "Insurance", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5400", name: "Payroll / Salaries", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5500", name: "Software Subscriptions", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5600", name: "Courier / Delivery", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5650", name: "Supplier Payments", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5700", name: "Travel / Meals / Entertainment", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5800", name: "Levies", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5900", name: "Finance Costs", type: "expense", group: "expense", statement: "profit_loss" },
  { number: "5950", name: "Other Operating Expenses", type: "expense", group: "expense", statement: "profit_loss" },
];

const BY_NUMBER = new Map(CHART.map((a) => [a.number, a]));
const acct = (number: string): ChartAccount => BY_NUMBER.get(number) as ChartAccount;

export const BANK_ACCOUNT = acct("1000");

// Map a free-text category to a chart account. Uses the account-type taxonomy
// first, then keyword refinement for specific expense/revenue accounts.
export function resolveAccount(category: string): ChartAccount {
  const c = (category || "").toLowerCase();
  const type = accountType(category);
  switch (type) {
    case "bank_charges":
      return acct("5000");
    case "tax":
      return acct("2100");
    case "director_loan":
      return acct("2300");
    case "loan":
      return acct("2000");
    case "refund":
      return acct("2910");
    case "transfer":
      return acct("2920");
    case "suspense":
      return acct("2900");
    case "revenue":
      if (/interest/.test(c)) return acct("4100");
      if (/cash deposit/.test(c)) return acct("4300");
      if (/review/.test(c)) return acct("4200");
      return acct("4000");
    case "expense":
    default:
      if (/motor|fuel|vehicle|petrol/.test(c)) return acct("5100");
      if (/communication|telephone|internet|airtime|data/.test(c)) return acct("5200");
      if (/insurance|funeral/.test(c)) return acct("5300");
      if (/salar|payroll|wages/.test(c)) return acct("5400");
      if (/software|subscription|saas/.test(c)) return acct("5500");
      if (/courier|delivery/.test(c)) return acct("5600");
      if (/supplier|industries|trading|enterprises|invoice/.test(c)) return acct("5650");
      if (/travel|meals|entertainment|welfare/.test(c)) return acct("5700");
      if (/levy|levies/.test(c)) return acct("5800");
      if (/finance cost|interest (paid|charged)/.test(c)) return acct("5900");
      return acct("5950");
  }
}

// ─── VAT ─────────────────────────────────────────────────────────────────────

export type VatCode = "STD" | "ZR" | "EX" | "OOS" | "REV";

export function vatCodeFor(treatment: string): VatCode {
  switch (treatment) {
    case "standard":
      return "STD";
    case "zero_rated":
      return "ZR";
    case "exempt":
      return "EX";
    case "out_of_scope":
      return "OOS";
    default:
      return "REV";
  }
}

const VAT_TREATMENT_LABEL: Record<VatCode, string> = {
  STD: "Standard 15%",
  ZR: "Zero-rated",
  EX: "Exempt",
  OOS: "Out of scope",
  REV: "Review required",
};

export type ClassificationSource = "Rule" | "Learned" | "AI" | "Manual";

function classificationSource(t: AccountingTransaction): ClassificationSource {
  if (t.reviewStatus === "approved") return "Manual";
  if (t.confidence >= 90) return "Rule";
  if (t.confidence >= 70) return "Learned";
  return "AI";
}

// ─── Enriched transaction (single source of per-transaction facts) ───────────

export type ModelTransaction = {
  id: string;
  date: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number | null;
  category: string;
  account: ChartAccount;
  vatCode: VatCode;
  vatTreatmentLabel: string;
  outputVat: number;
  inputVat: number;
  netVat: number;
  vatClaimable: boolean;
  sarsBox: string;
  confidence: number;
  source: ClassificationSource;
  reviewStatus: string;
  reviewReason: string;
  supportedByInvoice: boolean;
  bankCharge: boolean;
  sourcePage: number | null;
  notes: string;
};

function reviewReason(t: AccountingTransaction): string {
  if (t.vatTreatment === "review") return "VAT treatment unresolved";
  if (t.reviewStatus === "needs_review" || t.reviewStatus === "in_review") return "Flagged for review";
  if (accountType(t.accountCategory) === "suspense") return "Account unresolved";
  if (t.confidence < 80) return "Requires verification";
  return "";
}

export function enrichTransaction(t: AccountingTransaction): ModelTransaction {
  const account = resolveAccount(t.accountCategory);
  const vatCode = vatCodeFor(t.vatTreatment);
  const isStd = vatCode === "STD";
  const potentialInputReview =
    vatCode === "REV" &&
    (t.debitAmount ?? 0) > 0 &&
    account.statement === "profit_loss" &&
    account.type !== "bank_charges" &&
    !/travel|meal|entertainment|welfare/i.test(account.name);
  const outputVat = isStd ? (t.creditAmount ?? 0) * VAT_RATE : 0;
  const inputVat = isStd || potentialInputReview ? (t.debitAmount ?? 0) * VAT_RATE : 0;
  const sarsBox = isStd
    ? (t.creditAmount ?? 0) > 0
      ? "1 (Standard-rate supplies)"
      : "14/15 (Input VAT)"
    : vatCode === "ZR"
      ? "2 (Zero-rated)"
      : vatCode === "EX"
        ? "3 (Exempt/non-supplies)"
        : potentialInputReview
          ? "14/15 (Potential input VAT)"
          : "—";
  return {
    id: t.id,
    date: t.transactionDate ?? "",
    reference: (t.rawText ?? "").slice(0, 24) || t.id.slice(0, 8),
    description: t.description,
    debit: t.debitAmount ?? 0,
    credit: t.creditAmount ?? 0,
    balance: t.runningBalance,
    category: t.accountCategory,
    account,
    vatCode,
    vatTreatmentLabel: VAT_TREATMENT_LABEL[vatCode],
    outputVat,
    inputVat,
    netVat: outputVat - inputVat,
    vatClaimable: isStd && (t.debitAmount ?? 0) > 0 && t.supportedByInvoice,
    sarsBox,
    confidence: t.confidence,
    source: classificationSource(t),
    reviewStatus: t.reviewStatus,
    reviewReason: reviewReason(t),
    supportedByInvoice: t.supportedByInvoice,
    bankCharge: t.bankCharge,
    sourcePage: t.sourcePage,
    notes: t.notes,
  };
}

// ─── Journals (double-entry) ─────────────────────────────────────────────────

export type JournalLine = {
  transactionId: string;
  date: string;
  journalNo: string;
  reference: string;
  description: string;
  accountNumber: string;
  account: string;
  debit: number;
  credit: number;
  source: ClassificationSource;
  reviewStatus: string;
  sourcePage: number | null;
};

// Every bank transaction posts two legs: the category account and the bank
// contra. Money out => Dr category / Cr bank; money in => Dr bank / Cr category.
export function buildJournals(model: ModelTransaction[]): JournalLine[] {
  const journals: JournalLine[] = [];
  model.forEach((t, index) => {
    const journalNo = `J${String(index + 1).padStart(4, "0")}`;
    const base = {
      transactionId: t.id,
      date: t.date,
      journalNo,
      reference: t.reference,
      description: t.description,
      source: t.source,
      reviewStatus: t.reviewStatus,
      sourcePage: t.sourcePage,
    };
    if (t.debit > 0) {
      journals.push({ ...base, accountNumber: t.account.number, account: t.account.name, debit: t.debit, credit: 0 });
      journals.push({ ...base, accountNumber: BANK_ACCOUNT.number, account: BANK_ACCOUNT.name, debit: 0, credit: t.debit });
    }
    if (t.credit > 0) {
      journals.push({ ...base, accountNumber: BANK_ACCOUNT.number, account: BANK_ACCOUNT.name, debit: t.credit, credit: 0 });
      journals.push({ ...base, accountNumber: t.account.number, account: t.account.name, debit: 0, credit: t.credit });
    }
  });
  return journals;
}

// ─── General Ledger / Trial Balance ──────────────────────────────────────────

export type LedgerAccount = {
  number: string;
  name: string;
  group: AccountGroup;
  statement: StatementSide;
  debit: number;
  credit: number;
  movement: number; // debit - credit
  count: number;
};

export function buildLedger(journals: JournalLine[]): LedgerAccount[] {
  const map = new Map<string, LedgerAccount>();
  for (const line of journals) {
    const chart = BY_NUMBER.get(line.accountNumber) ?? BANK_ACCOUNT;
    const entry =
      map.get(line.accountNumber) ??
      ({ number: chart.number, name: chart.name, group: chart.group, statement: chart.statement, debit: 0, credit: 0, movement: 0, count: 0 } as LedgerAccount);
    entry.debit += line.debit;
    entry.credit += line.credit;
    entry.count += 1;
    map.set(line.accountNumber, entry);
  }
  const ledger = Array.from(map.values());
  ledger.forEach((a) => (a.movement = a.debit - a.credit));
  return ledger.sort((a, b) => a.number.localeCompare(b.number));
}

export type TrialBalanceRow = { number: string; name: string; debit: number; credit: number };
export type TrialBalance = { rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean };

export function buildTrialBalance(ledger: LedgerAccount[]): TrialBalance {
  const rows = ledger.map((a) => ({
    number: a.number,
    name: a.name,
    debit: a.movement > 0 ? a.movement : 0,
    credit: a.movement < 0 ? Math.abs(a.movement) : 0,
  }));
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

// ─── VAT201 boxes ────────────────────────────────────────────────────────────

export type Vat201 = {
  outputVat: number;
  inputVat: number;
  netVat: number;
  standardSupplies: number;
  zeroRated: number;
  exempt: number;
  reviewItems: number;
  missingInvoices: number;
  lowConfidence: number;
};

export function buildVat201(model: ModelTransaction[]): Vat201 {
  let outputVat = 0;
  let inputVat = 0;
  let standardSupplies = 0;
  let zeroRated = 0;
  let exempt = 0;
  let reviewItems = 0;
  let missingInvoices = 0;
  let lowConfidence = 0;
  for (const t of model) {
    outputVat += t.outputVat;
    inputVat += t.inputVat;
    if (t.vatCode === "STD" && t.credit > 0) standardSupplies += t.credit;
    if (t.vatCode === "ZR") zeroRated += t.credit + t.debit;
    if (t.vatCode === "EX") exempt += t.credit + t.debit;
    if (t.vatCode === "REV") reviewItems += 1;
    if (t.inputVat > 0 && t.debit > 0 && !t.supportedByInvoice) missingInvoices += 1;
    if (t.confidence < 70) lowConfidence += 1;
  }
  return {
    outputVat,
    inputVat,
    netVat: outputVat - inputVat,
    standardSupplies,
    zeroRated,
    exempt,
    reviewItems,
    missingInvoices,
    lowConfidence,
  };
}

// ─── Financial statements (derived from the ledger) ──────────────────────────

export type StatementGroup = { number: string; name: string; amount: number; count: number };

export type ModelFinancials = {
  revenue: StatementGroup[];
  expenses: StatementGroup[];
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  balanceSheet: { assets: StatementGroup[]; liabilities: StatementGroup[]; equity: StatementGroup[] };
};

export function buildFinancials(ledger: LedgerAccount[]): ModelFinancials {
  const g = (a: LedgerAccount): StatementGroup => ({ number: a.number, name: a.name, amount: Math.abs(a.movement), count: a.count });
  const revenue = ledger.filter((a) => a.group === "revenue" && a.statement === "profit_loss").map(g);
  const expenses = ledger.filter((a) => a.group === "expense").map(g);
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  return {
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netProfit: totalRevenue - totalExpenses,
    balanceSheet: {
      assets: ledger.filter((a) => a.group === "asset").map(g),
      liabilities: ledger.filter((a) => a.group === "liability").map(g),
      equity: ledger.filter((a) => a.group === "equity").map(g),
    },
  };
}

// ─── Validation (reused by the pack watermarking) ────────────────────────────

export type ModelValidation = {
  reconciled: boolean;
  reconciliationDifference: number;
  expectedClosing: number;
  totalCredits: number;
  totalDebits: number;
  transactionCount: number;
};

export function buildValidation(detail: AccountingRunDetail, model: ModelTransaction[]): ModelValidation {
  const totalCredits = model.reduce((s, t) => s + t.credit, 0);
  const totalDebits = model.reduce((s, t) => s + t.debit, 0);
  const opening = detail.run.openingBalance ?? 0;
  const closing = detail.run.closingBalance ?? 0;
  const expectedClosing = opening + totalCredits - totalDebits;
  const reconciliationDifference = expectedClosing - closing;
  return {
    reconciled: Math.abs(reconciliationDifference) < 0.01,
    reconciliationDifference,
    expectedClosing,
    totalCredits,
    totalDebits,
    transactionCount: model.length,
  };
}

// ─── The one model ───────────────────────────────────────────────────────────

export type AccountingModel = {
  transactions: ModelTransaction[];
  chartOfAccounts: ChartAccount[];
  usedAccounts: ChartAccount[];
  journals: JournalLine[];
  ledger: LedgerAccount[];
  trialBalance: TrialBalance;
  vat201: Vat201;
  financials: ModelFinancials;
  validation: ModelValidation;
};

export function buildAccountingModel(detail: AccountingRunDetail): AccountingModel {
  const transactions = detail.transactions.map(enrichTransaction);
  const journals = buildJournals(transactions);
  const ledger = buildLedger(journals);
  const usedNumbers = new Set(ledger.map((a) => a.number));
  return {
    transactions,
    chartOfAccounts: CHART,
    usedAccounts: CHART.filter((a) => usedNumbers.has(a.number)),
    journals,
    ledger,
    trialBalance: buildTrialBalance(ledger),
    vat201: buildVat201(transactions),
    financials: buildFinancials(ledger),
    validation: buildValidation(detail, transactions),
  };
}
