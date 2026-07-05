import type { AccountingStatementRun, AccountingTransaction } from "@/lib/accounting/types";

// ─── Output Types ─────────────────────────────────────────────────────────────

export type ProfitLossLine = { category: string; amount: number; count: number };

export type ProfitLossData = {
  revenue: ProfitLossLine[];
  expenses: ProfitLossLine[];
  totalRevenue: number;
  totalExpenses: number;
  netSurplus: number;
  interAccountTransfers: number;
  periodMonths: number;
  note: string;
};

export type CashFlowLine = { label: string; amount: number };

export type CashFlowData = {
  openingBalance: number | null;
  closingBalance: number | null;
  inflows: CashFlowLine[];
  outflows: CashFlowLine[];
  totalInflows: number;
  totalOutflows: number;
  netMovement: number;
  reconciled: boolean;
  note: string;
};

export type FinancialRatios = {
  expenseRatio: number | null;
  netCashMargin: number | null;
  cashCoverageRatio: number | null;
  avgMonthlyIncome: number | null;
  avgMonthlyExpenses: number | null;
  netMonthlyCashFlow: number | null;
  bankChargesRatio: number | null;
  periodMonths: number;
  note: string;
};

export type VatAnomalySeverity = "high" | "medium" | "low";

export type VatAnomaly = {
  id: string;
  type: string;
  severity: VatAnomalySeverity;
  description: string;
  transactionIds: string[];
  amount: number;
};

export type DuplicateGroup = {
  id: string;
  amount: number;
  transactions: AccountingTransaction[];
  confidence: number;
};

export type UnusualTransaction = {
  transaction: AccountingTransaction;
  reason: string;
  severity: "high" | "medium";
  zScore: number;
};

export type DirectorTransaction = {
  transaction: AccountingTransaction;
  matchedKeyword: string;
};

export type SarsRiskFactor = {
  name: string;
  score: number;
  maxScore: number;
  detail: string;
};

export type SarsRiskScore = {
  score: number;
  level: "low" | "moderate" | "elevated" | "high";
  factors: SarsRiskFactor[];
  summary: string;
};

export type ForecastMonth = {
  label: string;
  projectedIncome: number;
  projectedExpenses: number;
  projectedNetFlow: number;
  projectedClosingBalance: number;
};

export type ForecastData = {
  monthlyAvgIncome: number;
  monthlyAvgExpenses: number;
  monthlyNetFlow: number;
  projections: ForecastMonth[];
  currentBalance: number | null;
  periodMonths: number;
  note: string;
};

export type AuditFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type AuditFinding = {
  id: string;
  severity: AuditFindingSeverity;
  category: string;
  title: string;
  detail: string;
  count?: number;
};

export type AuditSummary = {
  findings: AuditFinding[];
  reviewItems: number;
  uncategorized: number;
  transactionsNeedingInvoice: AccountingTransaction[];
  riskScore: SarsRiskScore;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthsBetween(start: string | null, end: string | null): number {
  if (!start || !end) return 1;
  const s = new Date(start);
  const e = new Date(end);
  const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  return Math.max(1, months);
}

const TRANSFER_CATEGORIES = new Set(["Inter-account Transfer", "Interaccount Transfer"]);

// ─── Financial Statements ─────────────────────────────────────────────────────

export function computeProfitLoss(
  transactions: AccountingTransaction[],
  run: AccountingStatementRun,
): ProfitLossData {
  const periodMonths = monthsBetween(run.statementPeriodStart, run.statementPeriodEnd);
  const revenueMap = new Map<string, { amount: number; count: number }>();
  const expenseMap = new Map<string, { amount: number; count: number }>();
  let interAccountTransfers = 0;

  for (const t of transactions) {
    const cat = t.accountCategory || "Uncategorised";
    if (TRANSFER_CATEGORIES.has(cat)) {
      interAccountTransfers += (t.debitAmount ?? 0) + (t.creditAmount ?? 0);
      continue;
    }
    if (t.creditAmount) {
      const e = revenueMap.get(cat) ?? { amount: 0, count: 0 };
      e.amount += t.creditAmount;
      e.count += 1;
      revenueMap.set(cat, e);
    }
    if (t.debitAmount) {
      const e = expenseMap.get(cat) ?? { amount: 0, count: 0 };
      e.amount += t.debitAmount;
      e.count += 1;
      expenseMap.set(cat, e);
    }
  }

  const revenue = Array.from(revenueMap, ([category, v]) => ({ category, ...v })).sort(
    (a, b) => b.amount - a.amount,
  );
  const expenses = Array.from(expenseMap, ([category, v]) => ({ category, ...v })).sort(
    (a, b) => b.amount - a.amount,
  );

  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  return {
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netSurplus: totalRevenue - totalExpenses,
    interAccountTransfers,
    periodMonths,
    note: "Cash-basis statement derived from bank transaction data. Excludes accrued income, prepaid expenses, depreciation and capital items. Requires accountant review before finalisation.",
  };
}

export function computeCashFlow(
  transactions: AccountingTransaction[],
  run: AccountingStatementRun,
): CashFlowData {
  const inflowMap = new Map<string, number>();
  const outflowMap = new Map<string, number>();

  for (const t of transactions) {
    const cat = t.accountCategory || "Uncategorised";
    if (t.creditAmount) inflowMap.set(cat, (inflowMap.get(cat) ?? 0) + t.creditAmount);
    if (t.debitAmount) outflowMap.set(cat, (outflowMap.get(cat) ?? 0) + t.debitAmount);
  }

  const inflows = Array.from(inflowMap, ([label, amount]) => ({ label, amount })).sort(
    (a, b) => b.amount - a.amount,
  );
  const outflows = Array.from(outflowMap, ([label, amount]) => ({ label, amount })).sort(
    (a, b) => b.amount - a.amount,
  );

  const totalInflows = inflows.reduce((s, i) => s + i.amount, 0);
  const totalOutflows = outflows.reduce((s, o) => s + o.amount, 0);
  const netMovement = totalInflows - totalOutflows;
  const expectedClosing = (run.openingBalance ?? 0) + netMovement;
  const reconciled = Math.abs(expectedClosing - (run.closingBalance ?? expectedClosing)) < 0.02;

  return {
    openingBalance: run.openingBalance,
    closingBalance: run.closingBalance,
    inflows,
    outflows,
    totalInflows,
    totalOutflows,
    netMovement,
    reconciled,
    note: "Direct-method cash flow derived from bank statement. Investing and financing activities cannot be separately classified without full GL data.",
  };
}

export function computeFinancialRatios(
  transactions: AccountingTransaction[],
  run: AccountingStatementRun,
  totals: { debit: number; credit: number; bankCharges: number },
): FinancialRatios {
  const periodMonths = monthsBetween(run.statementPeriodStart, run.statementPeriodEnd);
  const { debit, credit, bankCharges } = totals;

  return {
    expenseRatio: credit > 0 ? debit / credit : null,
    netCashMargin: credit > 0 ? ((credit - debit) / credit) * 100 : null,
    cashCoverageRatio: debit > 0 ? credit / debit : null,
    avgMonthlyIncome: periodMonths > 0 ? credit / periodMonths : null,
    avgMonthlyExpenses: periodMonths > 0 ? debit / periodMonths : null,
    netMonthlyCashFlow: periodMonths > 0 ? (credit - debit) / periodMonths : null,
    bankChargesRatio: debit > 0 ? (bankCharges / debit) * 100 : null,
    periodMonths,
    note: "Ratios derived from bank statement cash movements only. Gross profit margin and operating margin require full GL and COGS data.",
  };
}

// ─── VAT Intelligence ─────────────────────────────────────────────────────────

const SERVICE_CATEGORIES_USUALLY_STANDARD = new Set([
  "Software Subscriptions",
  "Software / IT",
  "Courier / Delivery",
  "Motor Vehicle Expenses",
]);

export function detectVatAnomalies(transactions: AccountingTransaction[]): VatAnomaly[] {
  const anomalies: VatAnomaly[] = [];
  let idx = 0;

  // Large "review" VAT payments
  const largeReview = transactions.filter(
    (t) => t.vatTreatment === "review" && (t.debitAmount ?? t.creditAmount ?? 0) > 10000,
  );
  if (largeReview.length) {
    anomalies.push({
      id: `vat-${idx++}`,
      type: "large_review",
      severity: "high",
      description: `${largeReview.length} transaction${largeReview.length > 1 ? "s" : ""} over R10,000 with unresolved VAT treatment. These may have material VAT impact.`,
      transactionIds: largeReview.map((t) => t.id),
      amount: largeReview.reduce((s, t) => s + (t.debitAmount ?? t.creditAmount ?? 0), 0),
    });
  }

  // Income transactions with "review" VAT
  const incomeReview = transactions.filter(
    (t) => (t.creditAmount ?? 0) > 5000 && t.vatTreatment === "review",
  );
  if (incomeReview.length) {
    anomalies.push({
      id: `vat-${idx++}`,
      type: "income_review",
      severity: "high",
      description: `${incomeReview.length} receipt${incomeReview.length > 1 ? "s" : ""} over R5,000 with unresolved VAT. Unclassified output VAT creates SARS exposure.`,
      transactionIds: incomeReview.map((t) => t.id),
      amount: incomeReview.reduce((s, t) => s + (t.creditAmount ?? 0), 0),
    });
  }

  // Bank charges marked as standard VAT (should be exempt in SA)
  const badBankChargeVat = transactions.filter(
    (t) => t.bankCharge && t.vatTreatment === "standard",
  );
  if (badBankChargeVat.length) {
    anomalies.push({
      id: `vat-${idx++}`,
      type: "bank_charge_vat",
      severity: "medium",
      description: `${badBankChargeVat.length} bank charge${badBankChargeVat.length > 1 ? "s" : ""} marked as Standard VAT. Bank charges are typically exempt or zero-rated in South Africa.`,
      transactionIds: badBankChargeVat.map((t) => t.id),
      amount: badBankChargeVat.reduce((s, t) => s + (t.debitAmount ?? 0), 0),
    });
  }

  // Service-category transactions with zero-rated VAT (suspicious)
  const suspiciousZero = transactions.filter(
    (t) =>
      t.vatTreatment === "zero_rated" &&
      SERVICE_CATEGORIES_USUALLY_STANDARD.has(t.accountCategory),
  );
  if (suspiciousZero.length) {
    anomalies.push({
      id: `vat-${idx++}`,
      type: "suspicious_zero_rated",
      severity: "medium",
      description: `${suspiciousZero.length} transaction${suspiciousZero.length > 1 ? "s" : ""} in service categories (Software, Courier, etc.) marked zero-rated. These are typically standard-rated for SA VAT-registered vendors.`,
      transactionIds: suspiciousZero.map((t) => t.id),
      amount: suspiciousZero.reduce((s, t) => s + (t.debitAmount ?? t.creditAmount ?? 0), 0),
    });
  }

  // Mixed VAT treatments for same payee (same description prefix)
  const descVat = new Map<string, Set<string>>();
  for (const t of transactions) {
    const key = t.description.trim().toLowerCase().slice(0, 20);
    if (!descVat.has(key)) descVat.set(key, new Set());
    descVat.get(key)!.add(t.vatTreatment);
  }
  const mixedKeys = Array.from(descVat.entries())
    .filter(([, treatments]) => treatments.size > 1 && !treatments.has("review"))
    .map(([key]) => key);
  if (mixedKeys.length > 0) {
    const affected = transactions.filter((t) =>
      mixedKeys.some((k) => t.description.trim().toLowerCase().startsWith(k)),
    );
    if (affected.length) {
      anomalies.push({
        id: `vat-${idx++}`,
        type: "mixed_vat",
        severity: "low",
        description: `${mixedKeys.length} payee${mixedKeys.length > 1 ? "s appear" : " appears"} with inconsistent VAT treatments across transactions. Review for consistency.`,
        transactionIds: affected.map((t) => t.id),
        amount: affected.reduce((s, t) => s + (t.debitAmount ?? t.creditAmount ?? 0), 0),
      });
    }
  }

  return anomalies;
}

// ─── Transaction Intelligence ──────────────────────────────────────���──────────

function normalizeDesc(desc: string): string {
  return desc.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
}

function descSimilar(a: string, b: string): boolean {
  const na = normalizeDesc(a);
  const nb = normalizeDesc(b);
  if (na === nb) return true;
  if (na.slice(0, 30) === nb.slice(0, 30)) return true;
  // At least 2 shared words of length ≥ 4
  const wa = new Set(na.split(" ").filter((w) => w.length >= 4));
  const shared = nb.split(" ").filter((w) => w.length >= 4 && wa.has(w));
  return shared.length >= 2;
}

export function detectDuplicates(transactions: AccountingTransaction[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const payments = transactions.filter((t) => t.debitAmount && !t.bankCharge);

  // Group by amount for O(n * avg_group_size) instead of O(n²)
  const byAmount = new Map<string, AccountingTransaction[]>();
  for (const t of payments) {
    const key = (t.debitAmount ?? 0).toFixed(2);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key)!.push(t);
  }

  const used = new Set<string>();

  for (const sameAmount of byAmount.values()) {
    if (sameAmount.length < 2) continue;
    for (let i = 0; i < sameAmount.length; i++) {
      const a = sameAmount[i];
      if (used.has(a.id)) continue;
      const group: AccountingTransaction[] = [a];

      for (let j = i + 1; j < sameAmount.length; j++) {
        const b = sameAmount[j];
        if (used.has(b.id)) continue;
        if (a.transactionDate && b.transactionDate) {
          const days =
            Math.abs(
              new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime(),
            ) /
            (1000 * 60 * 60 * 24);
          if (days > 7) continue;
        }
        if (descSimilar(a.description, b.description)) {
          group.push(b);
          used.add(b.id);
        }
      }

      if (group.length >= 2) {
        group.forEach((t) => used.add(t.id));
        groups.push({
          id: `dup-${groups.length}`,
          amount: a.debitAmount ?? 0,
          transactions: group,
          confidence: group.length >= 3 ? 95 : 80,
        });
      }
    }
  }

  return groups;
}

export function detectUnusualTransactions(
  transactions: AccountingTransaction[],
): UnusualTransaction[] {
  const unusual: UnusualTransaction[] = [];

  function addOutliers(
    txns: AccountingTransaction[],
    getAmt: (t: AccountingTransaction) => number,
    label: (z: number, mean: number) => string,
  ) {
    if (txns.length < 5) return;
    const amounts = txns.map(getAmt);
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const stdDev = Math.sqrt(
      amounts.reduce((s, a) => s + Math.pow(a - mean, 2), 0) / amounts.length,
    );
    if (stdDev < 0.01) return;
    for (const t of txns) {
      const z = (getAmt(t) - mean) / stdDev;
      if (z > 2.5) {
        unusual.push({
          transaction: t,
          reason: label(z, mean),
          severity: z > 4 ? "high" : "medium",
          zScore: z,
        });
      }
    }
  }

  addOutliers(
    transactions.filter((t) => t.debitAmount && !t.bankCharge),
    (t) => t.debitAmount!,
    (z, mean) => `Unusually large payment — ${z.toFixed(1)}× above average (avg R${mean.toFixed(0)})`,
  );
  addOutliers(
    transactions.filter((t) => t.creditAmount),
    (t) => t.creditAmount!,
    (z, mean) => `Unusually large receipt — ${z.toFixed(1)}× above average (avg R${mean.toFixed(0)})`,
  );

  // Large round-number transactions not already flagged
  const flaggedIds = new Set(unusual.map((u) => u.transaction.id));
  const roundLarge = transactions.filter((t) => {
    const amt = t.debitAmount ?? t.creditAmount ?? 0;
    return amt >= 10000 && amt % 1000 === 0 && !flaggedIds.has(t.id);
  });
  for (const t of roundLarge.slice(0, 5)) {
    unusual.push({
      transaction: t,
      reason: `Large round-number ${t.debitAmount ? "payment" : "receipt"} — may indicate a cash transaction`,
      severity: "medium",
      zScore: 0,
    });
  }

  return unusual.sort((a, b) => b.zScore - a.zScore);
}

const DIRECTOR_KEYWORDS = [
  "director loan",
  "director's",
  "director ",
  "shareholder",
  " loan ",
  " dla ",
  " advance ",
];

export function detectDirectorTransactions(
  transactions: AccountingTransaction[],
): DirectorTransaction[] {
  const result: DirectorTransaction[] = [];
  for (const t of transactions) {
    const desc = ` ${t.description.toLowerCase()} `;
    const match = DIRECTOR_KEYWORDS.find((kw) => desc.includes(kw));
    if (match) result.push({ transaction: t, matchedKeyword: match.trim() });
  }
  return result;
}

// ─── SARS Risk Scoring ────────────────────────────────────────────────────────

export function computeSarsRisk(
  transactions: AccountingTransaction[],
  vatAnomalies: VatAnomaly[],
  duplicates: DuplicateGroup[],
  unusuals: UnusualTransaction[],
  directors: DirectorTransaction[],
): SarsRiskScore {
  const factors: SarsRiskFactor[] = [];
  let raw = 0;
  const total = Math.max(1, transactions.length);

  // Review item rate
  const reviewCount = transactions.filter(
    (t) =>
      t.reviewStatus === "needs_review" ||
      t.reviewStatus === "in_review" ||
      t.vatTreatment === "review" ||
      t.confidence < 80,
  ).length;
  const reviewPct = reviewCount / total;
  const reviewScore = reviewPct > 0.3 ? 25 : reviewPct > 0.1 ? 15 : reviewPct > 0.05 ? 8 : 3;
  raw += reviewScore;
  factors.push({
    name: "Review Item Rate",
    score: reviewScore,
    maxScore: 25,
    detail: `${(reviewPct * 100).toFixed(0)}% of transactions require review (${reviewCount} of ${total})`,
  });

  // VAT anomalies
  const highVat = vatAnomalies.filter((a) => a.severity === "high").length;
  const vatScore = highVat >= 3 ? 20 : highVat >= 1 ? 12 : vatAnomalies.length >= 3 ? 8 : vatAnomalies.length >= 1 ? 4 : 0;
  raw += vatScore;
  factors.push({
    name: "VAT Anomalies",
    score: vatScore,
    maxScore: 20,
    detail: vatAnomalies.length
      ? `${vatAnomalies.length} VAT anomal${vatAnomalies.length > 1 ? "ies" : "y"} (${highVat} high severity)`
      : "No VAT anomalies detected",
  });

  // Duplicate payments
  const dupScore = duplicates.length >= 3 ? 15 : duplicates.length >= 1 ? 8 : 0;
  raw += dupScore;
  factors.push({
    name: "Duplicate Payments",
    score: dupScore,
    maxScore: 15,
    detail: duplicates.length
      ? `${duplicates.length} potential duplicate group${duplicates.length > 1 ? "s" : ""} identified`
      : "No duplicate payments detected",
  });

  // Unusual transactions
  const highUnusual = unusuals.filter((u) => u.severity === "high").length;
  const unusualScore = highUnusual >= 3 ? 15 : highUnusual >= 1 ? 10 : unusuals.length >= 5 ? 8 : unusuals.length >= 1 ? 4 : 0;
  raw += unusualScore;
  factors.push({
    name: "Unusual Transactions",
    score: unusualScore,
    maxScore: 15,
    detail: unusuals.length
      ? `${unusuals.length} outlier transaction${unusuals.length > 1 ? "s" : ""} (${highUnusual} high severity)`
      : "No unusual transactions detected",
  });

  // Director / related-party activity
  const dirScore = directors.length >= 5 ? 10 : directors.length >= 1 ? 6 : 0;
  raw += dirScore;
  factors.push({
    name: "Director / Related-Party Activity",
    score: dirScore,
    maxScore: 10,
    detail: directors.length
      ? `${directors.length} transaction${directors.length > 1 ? "s" : ""} with director or shareholder keywords`
      : "No director-linked transactions detected",
  });

  // Uncategorised transactions
  const uncatCount = transactions.filter(
    (t) =>
      t.accountCategory === "Uncategorised" ||
      t.accountCategory === "Uncategorised Expense" ||
      t.accountCategory === "Review Required",
  ).length;
  const uncatPct = uncatCount / total;
  const uncatScore = uncatPct > 0.2 ? 15 : uncatPct > 0.1 ? 8 : uncatPct > 0.05 ? 4 : 0;
  raw += uncatScore;
  factors.push({
    name: "Uncategorised Transactions",
    score: uncatScore,
    maxScore: 15,
    detail: `${uncatCount} uncategorised (${(uncatPct * 100).toFixed(0)}% of total)`,
  });

  const score = Math.min(100, Math.round(raw));
  const level: SarsRiskScore["level"] =
    score <= 25 ? "low" : score <= 50 ? "moderate" : score <= 75 ? "elevated" : "high";

  const summaries = {
    low: "Statement appears well-classified with minimal anomalies. Suitable for review.",
    moderate: "Some items require attention. Resolve review queue and VAT anomalies before filing.",
    elevated: "Multiple risk factors detected. Accountant review recommended before SARS submission.",
    high: "Significant anomalies found. Do not use for SARS submissions without complete accountant review.",
  };

  return { score, level, factors, summary: summaries[level] };
}

// ─── Forecasting ──────────────────────────────────────────────────────────────

export function computeForecast(
  transactions: AccountingTransaction[],
  run: AccountingStatementRun,
  totals: { debit: number; credit: number },
): ForecastData {
  const periodMonths = monthsBetween(run.statementPeriodStart, run.statementPeriodEnd);
  const monthlyAvgIncome = totals.credit / periodMonths;
  const monthlyAvgExpenses = totals.debit / periodMonths;
  const monthlyNetFlow = monthlyAvgIncome - monthlyAvgExpenses;
  const currentBalance = run.closingBalance;

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const baseDate = run.statementPeriodEnd ? new Date(run.statementPeriodEnd) : new Date();
  const projections: ForecastMonth[] = Array.from({ length: 3 }, (_, i) => {
    const d = new Date(baseDate);
    d.setMonth(d.getMonth() + i + 1);
    return {
      label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
      projectedIncome: monthlyAvgIncome,
      projectedExpenses: monthlyAvgExpenses,
      projectedNetFlow: monthlyNetFlow,
      projectedClosingBalance: (currentBalance ?? 0) + monthlyNetFlow * (i + 1),
    };
  });

  // Count unique calendar months in transactions to validate period
  const _ = transactions; // used only for potential future recurring-payment detection

  return {
    monthlyAvgIncome,
    monthlyAvgExpenses,
    monthlyNetFlow,
    projections,
    currentBalance,
    periodMonths,
    note:
      periodMonths <= 1
        ? "Forecast based on a single month. Accuracy improves significantly with 3+ processed statements."
        : `Forecast based on ${periodMonths}-month average. Process additional statements to improve accuracy.`,
  };
}

// ─── Audit Summary ────────────────────────────────────────────────────────────

export function buildAuditSummary(
  transactions: AccountingTransaction[],
  run: AccountingStatementRun,
  duplicates: DuplicateGroup[],
  unusuals: UnusualTransaction[],
  vatAnomalies: VatAnomaly[],
  riskScore: SarsRiskScore,
): AuditSummary {
  const findings: AuditFinding[] = [];

  const reviewCount = transactions.filter(
    (t) => t.reviewStatus === "needs_review" || t.reviewStatus === "in_review",
  ).length;
  if (reviewCount > 0) {
    findings.push({
      id: "f-review",
      severity: reviewCount > 10 ? "high" : reviewCount > 3 ? "medium" : "low",
      category: "Review Queue",
      title: `${reviewCount} transaction${reviewCount > 1 ? "s" : ""} pending review`,
      detail: "Approve or update all transactions in the Review tab before using this data for reporting.",
      count: reviewCount,
    });
  }

  const uncatCount = transactions.filter(
    (t) =>
      t.accountCategory === "Uncategorised" ||
      t.accountCategory === "Uncategorised Expense" ||
      t.accountCategory === "Review Required",
  ).length;
  if (uncatCount > 0) {
    findings.push({
      id: "f-uncat",
      severity: uncatCount > 20 ? "high" : uncatCount > 5 ? "medium" : "low",
      category: "Categorisation",
      title: `${uncatCount} uncategorised transaction${uncatCount > 1 ? "s" : ""}`,
      detail: "Assign account categories to all transactions for accurate GL and P&L reports.",
      count: uncatCount,
    });
  }

  if (duplicates.length > 0) {
    findings.push({
      id: "f-dup",
      severity: "high",
      category: "Duplicate Payments",
      title: `${duplicates.length} potential duplicate payment group${duplicates.length > 1 ? "s" : ""}`,
      detail: "Review flagged payments. Duplicates may indicate overpayments requiring recovery.",
      count: duplicates.length,
    });
  }

  vatAnomalies
    .filter((a) => a.severity === "high")
    .forEach((a, i) => {
      findings.push({
        id: `f-vat-${i}`,
        severity: "high",
        category: "VAT",
        title: a.description.length > 90 ? a.description.slice(0, 90) + "…" : a.description,
        detail: "Resolve VAT treatment before filing VAT201. Unresolved output VAT creates SARS liability.",
      });
    });

  const highUnusuals = unusuals.filter((u) => u.severity === "high").length;
  if (highUnusuals > 0) {
    findings.push({
      id: "f-unusual",
      severity: "medium",
      category: "Unusual Transactions",
      title: `${highUnusuals} high-value outlier transaction${highUnusuals > 1 ? "s" : ""}`,
      detail: "Confirm these are genuine business transactions and obtain supporting documentation.",
      count: highUnusuals,
    });
  }

  const noInvoice = transactions.filter(
    (t) => (t.debitAmount ?? 0) > 5000 && !t.supportedByInvoice && !t.bankCharge,
  );
  if (noInvoice.length > 0) {
    findings.push({
      id: "f-invoice",
      severity: "medium",
      category: "Supporting Documents",
      title: `${noInvoice.length} payment${noInvoice.length > 1 ? "s" : ""} over R5,000 without linked invoice`,
      detail: 'Mark transactions as "Supported by Invoice" once documentation is attached.',
      count: noInvoice.length,
    });
  }

  const lowConfidence = transactions.filter((t) => t.confidence < 70).length;
  if (lowConfidence > 0) {
    findings.push({
      id: "f-confidence",
      severity: "low",
      category: "Extraction Quality",
      title: `${lowConfidence} transaction${lowConfidence > 1 ? "s" : ""} with low AI confidence (<70%)`,
      detail: "Manually verify amounts and descriptions for low-confidence extractions.",
      count: lowConfidence,
    });
  }

  const SEVERITY_ORDER: Record<AuditFindingSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // unused suppression for 'run' param (may be used in future for period-aware audit checks)
  void run;

  return {
    findings,
    reviewItems: reviewCount,
    uncategorized: uncatCount,
    transactionsNeedingInvoice: noInvoice,
    riskScore,
  };
}
