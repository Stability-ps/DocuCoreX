import type { AccountingStatementRun } from "@/lib/accounting/types";

type MismatchKind = "none" | "generic" | "confirmation_letter";

export type DocumentTypeMismatchAssessment = {
  kind: MismatchKind;
  isMismatch: boolean;
  title: string;
  body: string;
  detectedDocumentLabel: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function valuesText(record: Record<string, unknown> | null, keys: string[]): string[] {
  if (!record) return [];
  return keys.map((key) => text(record[key])).filter(Boolean);
}

function stageShowsReadableTextWithoutTransactions(stages: unknown): boolean {
  if (!Array.isArray(stages)) return false;
  return stages.some((stage) => {
    const row = asRecord(stage);
    if (!row) return false;
    const chars = typeof row.chars === "number" ? row.chars : 0;
    const transactions = typeof row.transactions === "number" ? row.transactions : 0;
    const ok = row.ok === true;
    return ok && chars >= 300 && transactions === 0;
  });
}

function includesAny(textBody: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(textBody));
}

export function assessDocumentTypeMismatch(run: Pick<
  AccountingStatementRun,
  "transactionCount" | "error" | "reviewReason" | "routeReason" | "detectedPdfType" | "parserDebug"
>): DocumentTypeMismatchAssessment {
  if ((run.transactionCount ?? 0) > 0) {
    return {
      kind: "none",
      isMismatch: false,
      title: "",
      body: "",
      detectedDocumentLabel: null,
    };
  }

  const parserDebug = asRecord(run.parserDebug);
  const combinedText = [
    text(run.error),
    text(run.reviewReason),
    text(run.routeReason),
    ...valuesText(parserDebug, ["reason_no_transactions", "sample_text"]),
  ]
    .join("\n")
    .toLowerCase();

  const noTransactionsEvidence =
    includesAny(combinedText, [
      /no[_\s-]?transactions?_parsed/,
      /no transactions could be parsed/,
      /no transaction rows were detected/,
      /text (?:was )?extracted .*no transaction rows/,
    ]) ||
    stageShowsReadableTextWithoutTransactions(parserDebug?.stages);

  const unreadableEvidence = includesAny(combinedText, [
    /no readable text/i,
    /ocr completed but no readable text/i,
    /timed out/i,
    /unreachable/i,
    /source unavailable/i,
    /encrypted/i,
  ]);

  const statementShapeEvidence = includesAny(combinedText, [
    /\bopening balance\b/,
    /\bclosing balance\b/,
    /\bstatement period\b/,
    /\btransactions in rand\b/,
    /\breconciliation\b/,
  ]);
  const parserFailureOnStatementEvidence = includesAny(combinedText, [
    /no fnb transactions could be parsed/,
    /no transactions could be parsed from this .*statement/,
    /statement (?:layout|format)/,
  ]);

  const readableEvidence =
    run.detectedPdfType === "digital" ||
    (typeof parserDebug?.pre_extracted_text_length === "number" && parserDebug.pre_extracted_text_length >= 300) ||
    stageShowsReadableTextWithoutTransactions(parserDebug?.stages) ||
    /text extracted/.test(combinedText);

  const confirmationMarkers = includesAny(combinedText, [
    /to whom it may concern/,
    /confirmation of (?:standard bank )?account/,
    /confirmation of bank account/,
    /proof of account/,
    /account verification/,
    /this letter serves to confirm/,
    /account confirmation letter/,
  ]);

  const isMismatch =
    readableEvidence &&
    noTransactionsEvidence &&
    !unreadableEvidence &&
    !statementShapeEvidence &&
    !parserFailureOnStatementEvidence;
  if (!isMismatch) {
    return {
      kind: "none",
      isMismatch: false,
      title: "",
      body: "",
      detectedDocumentLabel: null,
    };
  }

  if (confirmationMarkers) {
    return {
      kind: "confirmation_letter",
      isMismatch: true,
      title: "This document does not appear to be a bank statement",
      body:
        "We successfully read the document, but no bank-statement transactions were found. It appears to be a bank account confirmation letter. Please upload a bank statement that contains transaction activity.",
      detectedDocumentLabel: "Bank account confirmation letter",
    };
  }

  return {
    kind: "generic",
    isMismatch: true,
    title: "No bank statement transactions found",
    body:
      "We successfully read this document, but it does not appear to contain bank statement transaction activity. Please check that you uploaded a bank statement and try again.",
    detectedDocumentLabel: null,
  };
}
