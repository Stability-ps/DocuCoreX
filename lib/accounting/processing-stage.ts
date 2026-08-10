import type { AccountingStatementRun } from "@/lib/accounting/types";

export type AccountingProcessingStage =
  | "detecting"
  | "extracting"
  | "parsing"
  | "classifying"
  | "reconciling"
  | "generatingWorkbook";

export const ACCOUNTING_PROCESSING_STAGE_ORDER: AccountingProcessingStage[] = [
  "detecting",
  "extracting",
  "parsing",
  "classifying",
  "reconciling",
  "generatingWorkbook",
];

export const ACCOUNTING_PROCESSING_STAGE_LABELS: Record<AccountingProcessingStage, string> = {
  detecting: "Detecting document",
  extracting: "Extracting data",
  parsing: "Parsing transactions",
  classifying: "Classifying transactions",
  reconciling: "Reconciling",
  generatingWorkbook: "Generating workbook",
};

export function normalizeAccountingProcessingStage(value: string | null | undefined): AccountingProcessingStage {
  const label = (value ?? "").toLowerCase();
  if (/workbook|export/.test(label)) return "generatingWorkbook";
  if (/reconcil|validat|balance check/.test(label)) return "reconciling";
  if (/classif|counterparty|merchant/.test(label)) return "classifying";
  if (/pars|recovering with ai/.test(label)) return "parsing";
  if (/ocr|extract|text layer/.test(label)) return "extracting";
  return "detecting";
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Preserve the newest, furthest stage for one job while allowing a newer job to restart. */
export function mergeAccountingRunProgress(
  current: AccountingStatementRun | null | undefined,
  incoming: AccountingStatementRun,
): AccountingStatementRun {
  if (!current || current.id !== incoming.id) return incoming;

  const currentTime = timestamp(current.updatedAt);
  const incomingTime = timestamp(incoming.updatedAt);
  const sameJob = current.activeJobId === incoming.activeJobId;

  if (!sameJob) {
    // A new job may restart at Detecting. A delayed response from the old job
    // necessarily has an older run timestamp and must not reclaim the display.
    if (currentTime !== null && incomingTime !== null && incomingTime < currentTime) return current;
    return incoming;
  }

  if (currentTime !== null && incomingTime !== null && incomingTime < currentTime) return current;

  const currentRank = ACCOUNTING_PROCESSING_STAGE_ORDER.indexOf(normalizeAccountingProcessingStage(current.processingStep));
  const incomingRank = ACCOUNTING_PROCESSING_STAGE_ORDER.indexOf(normalizeAccountingProcessingStage(incoming.processingStep));
  if (incomingRank < currentRank && (incoming.status === "queued" || incoming.status === "processing")) {
    return { ...incoming, processingStep: current.processingStep, updatedAt: current.updatedAt };
  }
  return incoming;
}
