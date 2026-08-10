import test from "node:test";
import assert from "node:assert/strict";
import { assessDocumentTypeMismatch } from "../../lib/accounting/document-type-mismatch.ts";

test("CASE A: confirmation-letter evidence is classified as document type mismatch", () => {
  const assessment = assessDocumentTypeMismatch({
    transactionCount: 0,
    error: "Text extracted by pdfjs but no transaction rows were detected. To Whom it May Concern. This letter serves to confirm your Standard Bank account.",
    reviewReason: null,
    routeReason: "native digital text layer",
    detectedPdfType: "digital",
    parserDebug: {
      reason_no_transactions: "Text extracted by pdfjs but no transaction rows were detected",
      stages: [{ ok: true, chars: 1900, transactions: 0 }],
      pre_extracted_text_length: 1800,
    },
  });

  assert.equal(assessment.isMismatch, true);
  assert.equal(assessment.kind, "confirmation_letter");
  assert.match(assessment.title, /does not appear to be a bank statement/i);
});

test("CASE B: statement-shaped zero-row failure is not mislabeled as confirmation letter", () => {
  const assessment = assessDocumentTypeMismatch({
    transactionCount: 0,
    error: "No transactions could be parsed from this Standard Bank statement.",
    reviewReason: "Opening balance and closing balance did not reconcile for statement period.",
    routeReason: "bank statement extraction route",
    detectedPdfType: "digital",
    parserDebug: {
      reason_no_transactions: "No transactions could be parsed from this Standard Bank statement.",
      stages: [{ ok: true, chars: 2500, transactions: 0 }],
      pre_extracted_text_length: 2300,
    },
  });

  assert.equal(assessment.isMismatch, false);
  assert.equal(assessment.kind, "none");
});

test("CASE C: unreadable extraction failure remains on the normal failure path", () => {
  const assessment = assessDocumentTypeMismatch({
    transactionCount: 0,
    error: "OCR completed but no readable text was found.",
    reviewReason: null,
    routeReason: "scanned",
    detectedPdfType: "scanned",
    parserDebug: {
      reason_no_transactions: "OCR completed but no readable text was found",
      stages: [{ ok: false, chars: 0, transactions: 0 }],
      pre_extracted_text_length: 0,
    },
  });

  assert.equal(assessment.isMismatch, false);
  assert.equal(assessment.kind, "none");
});

test("CASE D: valid statement with transactions is never treated as a mismatch", () => {
  const assessment = assessDocumentTypeMismatch({
    transactionCount: 613,
    error: null,
    reviewReason: null,
    routeReason: "native",
    detectedPdfType: "digital",
    parserDebug: null,
  });

  assert.equal(assessment.isMismatch, false);
  assert.equal(assessment.kind, "none");
});
