import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { detectBankFromText, bankDetectionHints, UNKNOWN_BANK_ID, normaliseStatementText } = await import(
  "@/lib/accounting/engine/bank-detection.ts"
);
const registry = await import("@/lib/accounting/engine/registry.ts");

// A real 37-page Standard Bank statement extracted cleanly (66k-78k characters
// across pdfjs / pdfplumber / Azure / Mistral, account number and opening
// balance both found) and then failed with "No FNB transactions could be parsed
// from this PDF" because it was routed to parser_profile fnb_business_v1.
// These cases pin the detection that stops that happening. They mirror
// workers/accounting_worker/engine/detection.py — the two must agree.

const STANDARD_BANK_SAMPLE = `
STANDARD BANK 6 month statement
Website:
www.standardbank.co.za
Customer Care Line 0860 123 000
Account Number 123 456 789
Date Description Payments Deposits Balance
STATEMENT OPENING BALANCE -992,452.57
30 Apr 25 ADT JHB 1,204.55 -993,657.12
30 Apr 25 SBSARETAIL 340.00 -993,997.12
02 May 25 SALARY DEPOSIT 45,000.00 -948,997.12
`;

const FNB_SAMPLE = `
FIRST NATIONAL BANK
A division of FirstRand Bank Limited
www.fnb.co.za
Platinum Business Account
Statement Number 118
Transactions in RAND (ZAR)
01 Mar EFT Deposit Client 1,000.00Cr 1,000.00 Cr
01 Mar Card Purchase Fuel 300.00 700.00 Cr
`;

const BANK_SAMPLES: Array<[string, string]> = [
  ["fnb_business_v1", FNB_SAMPLE],
  ["standard_bank_business_v1", STANDARD_BANK_SAMPLE],
  ["absa_business_v1", "ABSA BANK LIMITED\nwww.absa.co.za\nCheque Account Statement\nDate Description Debit Credit Balance\n"],
  ["nedbank_business_v1", "NEDBANK LIMITED\nwww.nedbank.co.za\nBusiness Account Statement\nDate Description Debit Credit Balance\n"],
  ["capitec_business_v1", "CAPITEC BANK LIMITED\nwww.capitecbank.co.za\nBusiness Account Statement\nDate Description Money In Money Out Balance\n"],
  ["investec_business_v1", "INVESTEC BANK LIMITED\nwww.investec.co.za\nPrivate Bank Account Statement\nDate Description Debit Credit Balance\n"],
];

test("the failing Standard Bank statement is detected from its own text", () => {
  const detection = detectBankFromText(STANDARD_BANK_SAMPLE);
  assert.equal(detection.profileId, "standard_bank_business_v1");
  assert.equal(detection.bankName, "Standard Bank");
  assert.equal(detection.reason, "matched_bank_markers");
  assert.ok(detection.confidence >= 90, `expected high confidence, got ${detection.confidence}`);
  assert.ok(detection.evidence.length > 0, "a positive detection must name its evidence");
});

test("every supported bank is detected from statement text", () => {
  for (const [expected, sample] of BANK_SAMPLES) {
    assert.equal(detectBankFromText(sample).profileId, expected, `${expected} should be detected`);
  }
});

test("FNB detection is unchanged — it is the one bank with a real parser", () => {
  const detection = detectBankFromText(FNB_SAMPLE);
  assert.equal(detection.profileId, "fnb_business_v1");
  assert.equal(detection.bankName, "FNB South Africa");
});

test("an unidentified statement is unknown, never a default bank", () => {
  const cases: Array<[string, string | null | undefined]> = [
    ["empty text", ""],
    ["null", null],
    ["undefined", undefined],
    ["whitespace only", "   \n\t  "],
    ["no bank markers", "Ledger Export\nDate Description Debit Credit Balance\n01 Jan Opening 0.00 0.00 100.00"],
  ];
  for (const [label, sample] of cases) {
    const detection = detectBankFromText(sample);
    assert.equal(detection.profileId, UNKNOWN_BANK_ID, `${label} must be unknown`);
    assert.equal(detection.confidence, 0, `${label} must carry no confidence`);
  }
});

test("a bank named in a transaction description is not the issuer", () => {
  const fnbPayingStandardBank = `${FNB_SAMPLE}\n02 Mar EFT STANDARD BANK TRANSFER 5,000.00 -4,300.00\n`;
  assert.equal(detectBankFromText(fnbPayingStandardBank).profileId, "fnb_business_v1");

  // Also the storage-path guard: a stray "fnb" token in the body must not pull
  // the statement back to the FNB parser.
  const standardBankPayingFnb = `${STANDARD_BANK_SAMPLE}\n05 May 25 EFT FNB TRANSFER 2,500.00 -951,497.12\n`;
  assert.equal(detectBankFromText(standardBankPayingFnb).profileId, "standard_bank_business_v1");
});

test("balanced evidence for two banks resolves to unknown, not a coin flip", () => {
  const detection = detectBankFromText("STANDARD BANK\nNEDBANK\nDate Description Debit Credit Balance\n");
  assert.equal(detection.profileId, UNKNOWN_BANK_ID);
  assert.ok(detection.reason.startsWith("ambiguous"), `expected an ambiguity reason, got ${detection.reason}`);
});

test("a letterhead broken across lines by OCR is still detected", () => {
  const broken = "STANDARD\n  BANK\n  6 month   statement\nwww.standardbank.co.za\n";
  assert.equal(detectBankFromText(broken).profileId, "standard_bank_business_v1");
  assert.equal(normaliseStatementText("STANDARD  BANK\n"), "standard bank");
});

// ── Worker handoff ────────────────────────────────────────────────────────────

test("the detection travels to the worker under its ProcessRequest field names", () => {
  const hints = bankDetectionHints(detectBankFromText(STANDARD_BANK_SAMPLE));
  assert.deepEqual(Object.keys(hints).sort(), [
    "detected_bank",
    "detected_bank_confidence",
    "detected_bank_evidence",
    "detected_bank_name",
    "detected_bank_reason",
  ]);
  assert.equal(hints.detected_bank, "standard_bank_business_v1");
  assert.equal(hints.detected_bank_name, "Standard Bank");
  assert.equal(hints.detected_bank_reason, "matched_bank_markers");
  assert.ok(hints.detected_bank_confidence >= 90);
  assert.ok(Array.isArray(hints.detected_bank_evidence) && hints.detected_bank_evidence.length > 0);
});

test("an unknown verdict is still sent — silence would look like an older deploy", () => {
  const hints = bankDetectionHints(detectBankFromText("Ledger Export\nDate Description Debit Credit Balance\n"));
  assert.equal(hints.detected_bank, UNKNOWN_BANK_ID);
  assert.equal(hints.detected_bank_name, "Unknown");
  assert.equal(hints.detected_bank_confidence, 0);
  assert.deepEqual(hints.detected_bank_evidence, []);
  // The worker reads `detected_bank: null` as "this side never looked", so an
  // unknown verdict must never be sent as null or omitted.
  assert.notEqual(hints.detected_bank, null);
});

test("the handoff carries no diagnostic scores into the worker contract", () => {
  const detection = detectBankFromText(STANDARD_BANK_SAMPLE);
  assert.ok(Object.keys(detection.scores).length > 0, "scores exist for this side's logs");
  assert.equal("scores" in bankDetectionHints(detection), false);
  assert.equal("detected_bank_scores" in bankDetectionHints(detection), false);
});

test("detection takes statement text only — no path can reach it", () => {
  // Every accounting upload is stored at "{workspace}/accounting/fnb/{uuid}-{name}"
  // (accountingStoragePath, lib/accounting/server.ts), so any detector that reads
  // a path matches FNB for every document ever uploaded.
  assert.equal(detectBankFromText.length, 1, "detectBankFromText must take exactly one argument: the text");

  // Runs uploaded before the path went neutral still carry ".../accounting/fnb/".
  // They must route on their text like everything else.
  const legacyStoragePath = "ws-1/accounting/fnb/2f6c-Standard_Bank_Statement.pdf";
  assert.equal(detectBankFromText(STANDARD_BANK_SAMPLE).profileId, "standard_bank_business_v1");
  assert.ok(legacyStoragePath.includes("fnb"), "the legacy path really does contain the token");

  // The path-aware detector is gone, not merely unused. Leaving it exported is
  // an invitation to call it again.
  assert.equal("detectBankProfile" in registry, false, "detectBankProfile must not exist any more");
});
