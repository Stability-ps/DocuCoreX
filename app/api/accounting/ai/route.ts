import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { generateCommentary, type AiCommentaryType } from "@/lib/accounting/ai-service";
import {
  detectDuplicates,
  detectVatAnomalies,
  detectUnusualTransactions,
  detectDirectorTransactions,
  computeSarsRisk,
} from "@/lib/accounting/analytics";

const VALID_TYPES = new Set<AiCommentaryType>([
  "executive-summary",
  "audit-notes",
  "vat-commentary",
  "risk-explanation",
  "forecast-commentary",
]);

export async function POST(request: Request) {
  const context = await getWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    runId?: string;
    type?: string;
  };

  if (!body.runId || !body.type) {
    return NextResponse.json({ error: "runId and type are required" }, { status: 400 });
  }

  if (!VALID_TYPES.has(body.type as AiCommentaryType)) {
    return NextResponse.json({ error: "Invalid commentary type" }, { status: 400 });
  }

  const detail = await getAccountingRunDetail(body.runId);
  if (!detail) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { transactions, run } = detail;

  const totalCredits = transactions.reduce((s, t) => s + (t.creditAmount ?? 0), 0);
  const totalDebits = transactions.reduce((s, t) => s + (t.debitAmount ?? 0), 0);
  const reviewCount = transactions.filter(
    (t) => t.reviewStatus === "needs_review" || t.vatTreatment === "review",
  ).length;

  const vatAnomalies = detectVatAnomalies(transactions);
  const duplicates = detectDuplicates(transactions);
  const unusuals = detectUnusualTransactions(transactions);
  const directors = detectDirectorTransactions(transactions);
  const riskScore = computeSarsRisk(transactions, vatAnomalies, duplicates, unusuals, directors);

  const result = await generateCommentary(body.type as AiCommentaryType, {
    companyName: run.companyName,
    periodStart: run.statementPeriodStart,
    periodEnd: run.statementPeriodEnd,
    totalCredits,
    totalDebits,
    netSurplus: totalCredits - totalDebits,
    transactionCount: transactions.length,
    reviewCount,
    confidence: Math.round(run.confidence),
    riskScore: riskScore.score,
    riskLevel: riskScore.level,
    vatAnomalyCount: vatAnomalies.length,
    duplicateCount: duplicates.length,
    unusualCount: unusuals.length,
    openingBalance: run.openingBalance,
    closingBalance: run.closingBalance,
  });

  return NextResponse.json(result);
}
