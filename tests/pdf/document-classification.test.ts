import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { classifyDocumentText } = await import("@/lib/ocr/classifyDocument.ts");
const { resolveDetectedType } = await import("@/lib/ocr/detectedType.ts");
const { validateCommercialDocument, validateUncheckedDocument } = await import("@/lib/ocr/validateDocument.ts");
const { EXTRACTION_JSON_SCHEMA, parseStructuredContent } = await import("@/lib/providers/openai/extraction.ts");

const INVOICE = `ACME TEST SUPPLIES (PTY) LTD
12 Main Road, Cape Town  VAT No 4123456789
TAX INVOICE
Invoice No: INV-2026-1008        Invoice Date: 08/10/2026
Bill To: Northwind Traders CC, 4 Long Street, Durban
Description            Qty   Unit Price    Amount
Printer paper A4         2       120.00    240.00
Toner cartridge          1       850.00    850.00
Subtotal                                  1 090.00
VAT 15%                                     163.50
Total Due                                 1 253.50
Due Date: 07/11/2026`;

const RECEIPT = `CORNER CAFE
Cash Sale Receipt  #000412
08/10/2026 09:14
Flat white      1  38.00
Croissant       1  32.00
Total              70.00
Tendered          100.00
Change Due         30.00
Thank you!`;

const BANK_STATEMENT = `FIRST NATIONAL BANK
Bank Statement
Account Number: 62000000001
Statement period 01/09/2026 - 30/09/2026
Opening Balance 10 000.00
02/09 Payment received invoice 1182   1 500.00  11 500.00
05/09 Card purchase                     250.00  11 250.00
Closing Balance 11 250.00`;

const FINANCIAL_STATEMENT = `NORTHWIND TRADERS CC
Annual Financial Statements for the year ended 28 February 2026
Statement of Financial Position
Total assets          1 250 000
Total liabilities       400 000
Total equity            850 000
Statement of Comprehensive Income
Revenue               3 200 000
Gross profit          1 100 000`;

const LETTER = `Dear Ms Smith,
Thank you for meeting with us last week. We look forward to working together.
Kind regards,
J. Dlamini`;

// ── Text classification ──────────────────────────────────────────────────────

test("a tax invoice is classified as an invoice", () => {
  assert.equal(classifyDocumentText(INVOICE).type, "invoice");
});

test("receipts, bank statements and financial statements classify as themselves", () => {
  assert.equal(classifyDocumentText(RECEIPT).type, "receipt");
  assert.equal(classifyDocumentText(BANK_STATEMENT).type, "bank_statement");
  assert.equal(classifyDocumentText(FINANCIAL_STATEMENT).type, "financial_statement");
});

test("a statement that mentions an invoice in a transaction stays a bank statement", () => {
  assert.equal(classifyDocumentText(BANK_STATEMENT).type, "bank_statement");
});

test("a document that does not identify itself stays unknown", () => {
  assert.equal(classifyDocumentText(LETTER).type, "unknown");
  assert.equal(classifyDocumentText("").type, "unknown");
});

test("close candidates are not guessed between", () => {
  // Names itself both an invoice and a receipt: no clear lead.
  assert.equal(classifyDocumentText("INVOICE\nRECEIPT\nTotal 10.00").type, "unknown");
});

// ── Type resolution ──────────────────────────────────────────────────────────

test("the model's classification is used when the document has no known type", () => {
  assert.equal(resolveDetectedType("unknown", 2, null, null, { aiType: "invoice", textType: "invoice" }), "invoice");
  assert.equal(resolveDetectedType(undefined, 0, null, null, { aiType: "receipt" }), "receipt");
});

test("without AI, the text classification decides", () => {
  assert.equal(resolveDetectedType("unknown", 2, null, null, { aiType: null, textType: "invoice" }), "invoice");
});

test("statement evidence outranks the text classifier but not the model", () => {
  assert.equal(resolveDetectedType("unknown", 30, 1000, 900, { textType: "invoice" }), "bank_statement");
  assert.equal(resolveDetectedType("unknown", 30, 1000, 900, { aiType: "financial_statement" }), "financial_statement");
});

test("a known type is never overridden, and unknown evidence changes nothing", () => {
  assert.equal(resolveDetectedType("contract", 0, null, null, { aiType: "invoice", textType: "invoice" }), "contract");
  assert.equal(resolveDetectedType("unknown", 0, null, null, { aiType: "unknown", textType: "unknown" }), "unknown");
});

// ── Invoice validation and confidence ────────────────────────────────────────

const goodInvoice = {
  documentNumber: "INV-2026-1008",
  documentDate: "2026-10-08",
  issuerName: "Acme Test Supplies (Pty) Ltd",
  subtotal: 1090,
  taxAmount: 163.5,
  totalAmount: 1253.5,
  lineAmounts: [240, 850],
};

test("a complete, consistent invoice is Ready at full confidence", () => {
  const result = validateCommercialDocument(goodInvoice);
  assert.equal(result.status, "Ready");
  assert.equal(result.confidence, 100);
  assert.deepEqual(result.reasons, []);
});

test("an invoice whose figures do not add up needs review and says why", () => {
  const result = validateCommercialDocument({ ...goodInvoice, totalAmount: 1300 });
  assert.equal(result.status, "Review Required");
  assert.ok(result.confidence < 100);
  assert.ok(result.reasons.some((reason) => reason.includes("does not equal total")));
});

test("tax-inclusive line items reconcile to the total", () => {
  const result = validateCommercialDocument({ ...goodInvoice, subtotal: null, taxAmount: 163.5, lineAmounts: [70, 1183.5] });
  assert.equal(result.checks.find((c) => c.name === "line_items_sum")?.passed, true);
});

test("a commercial document with no total and no lines fails", () => {
  const result = validateCommercialDocument({ documentNumber: null, documentDate: null, issuerName: null, subtotal: null, taxAmount: null, totalAmount: null, lineAmounts: [] });
  assert.equal(result.status, "Failed");
  assert.equal(result.confidence, 0);
});

test("unchecked kinds are honest about having no automatic check", () => {
  const result = validateUncheckedDocument("financial_statement", { issuerName: "Northwind", documentDate: "2026-02-28" });
  assert.equal(result.status, "Review Required");
  assert.equal(result.confidence, 67);
  assert.match(result.reasons[0], /financial statement/);
});

// ── Extraction schema ────────────────────────────────────────────────────────

test("the extraction schema asks the model to classify and carries invoice fields", () => {
  const properties = EXTRACTION_JSON_SCHEMA.schema.properties as Record<string, unknown>;
  for (const field of ["documentType", "documentNumber", "documentDate", "issuerName", "subtotal", "taxAmount", "totalAmount"]) {
    assert.ok(field in properties, field);
    assert.ok((EXTRACTION_JSON_SCHEMA.schema.required as readonly string[]).includes(field), `${field} is required (strict mode)`);
  }
  const itemProps = (EXTRACTION_JSON_SCHEMA.schema.properties.lineItems.items.properties) as Record<string, unknown>;
  for (const field of ["quantity", "unitPrice", "amount"]) assert.ok(field in itemProps, field);
});

test("a type outside the schema enum is not trusted", () => {
  const parsed = parseStructuredContent(JSON.stringify({ documentType: "spreadsheet", lineItems: [] }));
  assert.equal(parsed.documentType, "unknown");
  assert.equal(parseStructuredContent(JSON.stringify({ documentType: "invoice", lineItems: [] })).documentType, "invoice");
});
