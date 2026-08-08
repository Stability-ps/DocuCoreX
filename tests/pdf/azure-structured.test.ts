// Phase 2: Azure structured parsing.
//
// The contract these tests defend is that structure is recovered WITHOUT
// changing any extraction decision — combinedText, transactions, metadata and
// confidence must be byte-identical to what the provider produced before.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const azure = await import("@/lib/pdf/extractWithAzureDocumentIntelligence.ts");
const { roleForLabel, resolveColumnRoles, isTransactionTable } = await import("@/lib/pdf/azure/columnRoles.ts");
const { normalizeTable, normalizeTables, cellConfidence, toPageMeta } = await import("@/lib/pdf/azure/normalizeTables.ts");
const { rowsFromTable, isContinuationCandidate, MAX_JOINS_PER_ROW } = await import("@/lib/pdf/azure/rowsFromTables.ts");
const { toLayoutBlocks, contentBlocks, textFromLayout } = await import("@/lib/pdf/azure/layout.ts");
const { buildStructured, structuredSummary } = await import("@/lib/pdf/azure/buildStructured.ts");
const { extentOf, median, verticalGap, horizontalOverlap } = await import("@/lib/pdf/azure/geometry.ts");

const ENDPOINT = "https://example.cognitiveservices.azure.com";
const KEY = "placeholder-not-a-real-key";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function scriptFetch(responses: Array<Response | Error>) {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

const accepted202 = () =>
  new Response(null, { status: 202, headers: { "operation-location": `${ENDPOINT}/documentintelligence/documentModels/prebuilt-layout/analyzeResults/abc` } });
const succeeded = (body: Record<string, unknown>) =>
  new Response(JSON.stringify({ status: "succeeded", analyzeResult: body }), { status: 200, headers: { "content-type": "application/json" } });

/** Axis-aligned polygon helper: 4 corners, clockwise from top-left. */
const box = (left: number, top: number, right: number, bottom: number) => [left, top, right, top, right, bottom, left, bottom];
const region = (pageNumber: number, l: number, t: number, r: number, b: number) => [{ pageNumber, polygon: box(l, t, r, b) }];

// ── Geometry ─────────────────────────────────────────────────────────────────

test("extents come from all four corners, so a skewed polygon is not mis-measured", () => {
  // Rotated quad: reading corner 0 and corner 2 alone would understate the box.
  const skewed = { pageNumber: 1, polygon: [1, 0.2, 3, 0, 3.2, 1, 1.2, 1.2] };
  const extent = extentOf(skewed);
  assert.deepEqual(extent, { top: 0, bottom: 1.2, left: 1, right: 3.2 });

  assert.equal(extentOf({ pageNumber: 1, polygon: [1, 2, 3] }), null, "short polygon is unusable, not partially trusted");
  assert.equal(extentOf({ pageNumber: 1, polygon: box(0, 0, NaN, 1) }), null, "NaN corner is unusable");
  assert.equal(extentOf(undefined), null);
});

test("median handles even and odd lengths and ignores non-finite values", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, Infinity]), null);
});

test("vertical gap is signed and horizontal overlap is normalised to the narrower box", () => {
  const top = { pageNumber: 1, polygon: box(0, 0, 10, 1) };
  const below = { pageNumber: 1, polygon: box(0, 1.5, 10, 2.5) };
  assert.equal(verticalGap(top, below), 0.5);
  assert.ok((verticalGap(below, top) ?? 0) < 0, "reversed order is negative");

  assert.equal(horizontalOverlap(top, below), 1, "identical spans overlap fully");
  assert.equal(horizontalOverlap(top, { pageNumber: 1, polygon: box(20, 0, 30, 1) }), 0, "disjoint spans do not overlap");
  // Narrow box fully inside a wide one ⇒ 1, because the narrower span is covered.
  assert.equal(horizontalOverlap(top, { pageNumber: 1, polygon: box(2, 1.5, 4, 2.5) }), 1);
});

// ── Column roles ─────────────────────────────────────────────────────────────

test("header labels resolve semantically, and the specific beats the generic", () => {
  assert.equal(roleForLabel("Date"), "date");
  assert.equal(roleForLabel("Transaction Date"), "date");
  assert.equal(roleForLabel("Description"), "description");
  assert.equal(roleForLabel("Details"), "description");
  assert.equal(roleForLabel("Balance"), "balance");
  assert.equal(roleForLabel("Closing Balance"), "balance");
  assert.equal(roleForLabel("Amount"), "amount");
  assert.equal(roleForLabel("Reference"), "reference");

  // "Debit Amount" is a debit column, not a signed amount column: the more
  // specific money word must win or the sign is lost.
  assert.equal(roleForLabel("Debit Amount"), "debit");
  assert.equal(roleForLabel("Credit Amount"), "credit");
  // "Balance Amount" is a balance, not an amount.
  assert.equal(roleForLabel("Balance Amount"), "balance");

  // Punctuation and casing must not defeat matching.
  assert.equal(roleForLabel("  DATE:  "), "date");
  assert.equal(roleForLabel("(Balance)"), "balance");

  // Unmatched labels stay unknown — never guessed into a role.
  assert.equal(roleForLabel("Sequence"), "unknown");
  assert.equal(roleForLabel(""), "unknown");
});

test("roles map by column index from header cells, not from row 0 blindly", () => {
  const headers = resolveColumnRoles(
    [
      // A banner in row 0 that Azure did NOT mark as a header.
      { rowIndex: 0, columnIndex: 0, rowSpan: 1, columnSpan: 4, content: "FNB BUSINESS ACCOUNT", kind: "content" },
      { rowIndex: 1, columnIndex: 0, rowSpan: 1, columnSpan: 1, content: "Date", kind: "columnHeader" },
      { rowIndex: 1, columnIndex: 1, rowSpan: 1, columnSpan: 1, content: "Description", kind: "columnHeader" },
      { rowIndex: 1, columnIndex: 2, rowSpan: 1, columnSpan: 1, content: "Amount", kind: "columnHeader" },
      { rowIndex: 1, columnIndex: 3, rowSpan: 1, columnSpan: 1, content: "Balance", kind: "columnHeader" },
    ] as never,
    4,
  );
  assert.deepEqual(headers.map((h) => h.role), ["date", "description", "amount", "balance"]);
});

test("a two-row header keeps the informative half", () => {
  const headers = resolveColumnRoles(
    [
      { rowIndex: 0, columnIndex: 0, rowSpan: 1, columnSpan: 1, content: "Transaction", kind: "columnHeader" },
      { rowIndex: 1, columnIndex: 0, rowSpan: 1, columnSpan: 1, content: "Date", kind: "columnHeader" },
    ] as never,
    1,
  );
  // "Transaction" resolves to description; "Date" is more specific and must not
  // be discarded merely for coming second.
  assert.equal(headers[0].role, "date");
});

test("the transaction table needs a date AND a money column", () => {
  assert.equal(isTransactionTable([{ role: "date" }, { role: "amount" }] as never), true);
  assert.equal(isTransactionTable([{ role: "date" }, { role: "balance" }] as never), true);
  assert.equal(isTransactionTable([{ role: "date" }, { role: "debit" }] as never), true);
  // A fee schedule: descriptions and amounts, no dates.
  assert.equal(isTransactionTable([{ role: "description" }, { role: "amount" }] as never), false);
  // A period table: dates but no money.
  assert.equal(isTransactionTable([{ role: "date" }, { role: "description" }] as never), false);
  assert.equal(isTransactionTable([]), false);
});

// ── Table normalisation ──────────────────────────────────────────────────────

test("cells keep span, kind and geometry that the flat string[][] shape destroyed", () => {
  const table = normalizeTable(
    {
      rowCount: 2,
      columnCount: 2,
      boundingRegions: region(3, 0, 0, 10, 5),
      cells: [
        { rowIndex: 0, columnIndex: 0, content: "Date", kind: "columnHeader" },
        { rowIndex: 0, columnIndex: 1, content: "Amount", kind: "columnHeader" },
        { rowIndex: 1, columnIndex: 0, columnSpan: 2, content: "01 Apr", boundingRegions: region(3, 0, 1, 4, 2) },
      ],
    } as never,
    [],
  );

  assert.equal(table.pageNumber, 3, "page comes from the table's bounding region");
  // Azure omits rowSpan/columnSpan when they are 1; a missing value is 1, not 0.
  assert.equal(table.cells[0].rowSpan, 1);
  assert.equal(table.cells[0].columnSpan, 1);
  assert.equal(table.cells[2].columnSpan, 2, "declared span is preserved");
  assert.equal(table.cells[0].kind, "columnHeader");
  assert.deepEqual(table.cells[2].region, { pageNumber: 3, polygon: box(0, 1, 4, 2) });
});

test("declared counts never truncate a cell that actually exists", () => {
  // Azure under-reporting rowCount must not silently drop transactions.
  const table = normalizeTable(
    { rowCount: 1, columnCount: 1, cells: [{ rowIndex: 4, columnIndex: 3, content: "late" }] } as never,
    [],
  );
  assert.equal(table.rowCount, 5);
  assert.equal(table.columnCount, 4);
  assert.equal(table.cells.length, 1);
});

test("cell confidence is the MINIMUM word confidence inside the cell", () => {
  const words = [
    { content: "GOOD", confidence: 0.99, span: { offset: 0, length: 4 } },
    { content: "BAD", confidence: 0.42, span: { offset: 5, length: 3 } },
    { content: "OTHER", confidence: 0.10, span: { offset: 50, length: 5 } },
  ];
  // Averaging would report 0.705 and hide the misread token — the whole point
  // of per-cell confidence is to flag the specific bad value.
  assert.equal(cellConfidence([{ offset: 0, length: 8 }], words as never), 0.42);
  assert.equal(cellConfidence([{ offset: 0, length: 4 }], words as never), 0.99, "a clean cell is not dragged down by its neighbour");
  assert.equal(cellConfidence(undefined, words as never), null, "no spans ⇒ null, never a fabricated number");
  assert.equal(cellConfidence([{ offset: 900, length: 5 }], words as never), null, "no words in range ⇒ null");
});

test("page metadata records unit and detected skew", () => {
  const meta = toPageMeta([{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", angle: 1.5 }] as never);
  assert.deepEqual(meta, [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", angle: 1.5 }]);
  const bare = toPageMeta([{}] as never);
  assert.deepEqual(bare, [{ pageNumber: 1, width: 0, height: 0, unit: "", angle: 0 }]);
});

// ── Rows, and the join rule ──────────────────────────────────────────────────

// A statement table laid out the way FNB actually prints one: the date appears
// once per date group, and wrapped merchant names occupy a row of their own.
function statementTable(rows: Array<{ date?: string; description: string; amount?: string; balance?: string; top: number; bottom: number; descLeft?: number; descRight?: number }>) {
  const cells: unknown[] = [
    { rowIndex: 0, columnIndex: 0, content: "Date", kind: "columnHeader" },
    { rowIndex: 0, columnIndex: 1, content: "Description", kind: "columnHeader" },
    { rowIndex: 0, columnIndex: 2, content: "Amount", kind: "columnHeader" },
    { rowIndex: 0, columnIndex: 3, content: "Balance", kind: "columnHeader" },
  ];
  rows.forEach((row, i) => {
    const rowIndex = i + 1;
    const push = (columnIndex: number, content: string | undefined, l: number, r: number) => {
      if (content === undefined) return;
      cells.push({ rowIndex, columnIndex, content, boundingRegions: region(1, l, row.top, r, row.bottom) });
    };
    push(0, row.date, 0, 1);
    push(1, row.description, row.descLeft ?? 1.2, row.descRight ?? 6);
    push(2, row.amount, 6.5, 7.5);
    push(3, row.balance, 8, 9);
  });
  return normalizeTable({ rowCount: rows.length + 1, columnCount: 4, boundingRegions: region(1, 0, 0, 9, 20), cells } as never, []);
}

test("REGRESSION: date-grouped rows are transactions, not continuations", () => {
  // FNB prints the date ONCE per group. Rows 2 and 3 have no date of their own
  // but DO carry amounts — they are real debits. The plan's original rule
  // ("no date + has description ⇒ continuation") would fold them into row 1 and
  // lose them, which is the ACAPOLITE class of failure the accounting
  // regression suite exists to catch.
  const table = statementTable([
    { date: "01 Apr", description: "Eft Credit Customer", amount: "37000.00", balance: "35660.05", top: 1, bottom: 1.4 },
    { description: "Internal Debit Order Fnbfuneral", amount: "676.02", balance: "333.65", top: 1.5, bottom: 1.9 },
    { description: "Excess Item Fee", amount: "310.00", balance: "23.65", top: 2.0, bottom: 2.4 },
  ]);

  const { rows, joined } = rowsFromTable(table);
  assert.equal(joined, 0, "nothing may be joined — every row carries money");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.cells.amount), ["37000.00", "676.02", "310.00"]);
  assert.equal(rows[0].cells.description, "Eft Credit Customer", "the first description must not absorb the others");
});

test("a wrapped description IS joined, and the merchant string is preserved verbatim", () => {
  const table = statementTable([
    { date: "01 Apr", description: "Fnb App Payment From", amount: "1200.00", balance: "5000.00", top: 1, bottom: 1.4 },
    // No date, NO amount, directly beneath, aligned to the description column.
    { description: "J SMITH TRADING CC", top: 1.5, bottom: 1.9 },
  ]);

  const { rows, joined } = rowsFromTable(table);
  assert.equal(joined, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cells.description, "Fnb App Payment From J SMITH TRADING CC");
  assert.deepEqual(rows[0].absorbedRows, [2], "provenance is recorded for auditing an over-merge");
  // Joined with a single space; no re-tokenising, no case or punctuation repair.
  assert.ok(!/\s{2,}/.test(String(rows[0].cells.description)));
});

test("a join is refused when geometry cannot confirm it", () => {
  // Same content, but the candidate sits far below its parent.
  const far = statementTable([
    { date: "01 Apr", description: "Fnb App Payment From", amount: "1200.00", top: 1, bottom: 1.4 },
    { description: "J SMITH TRADING CC", top: 9, bottom: 9.4 },
  ]);
  assert.equal(rowsFromTable(far).joined, 0, "too far below ⇒ refused");

  // Horizontally misaligned: a different column, not a wrapped description.
  const offset = statementTable([
    { date: "01 Apr", description: "Fnb App Payment From", amount: "1200.00", top: 1, bottom: 1.4 },
    { description: "J SMITH TRADING CC", top: 1.5, bottom: 1.9, descLeft: 20, descRight: 25 },
  ]);
  assert.equal(rowsFromTable(offset).joined, 0, "misaligned ⇒ refused");
});

test("with no polygons at all, joining is refused rather than assumed", () => {
  const table = normalizeTable(
    {
      rowCount: 3,
      columnCount: 3,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: "Date", kind: "columnHeader" },
        { rowIndex: 0, columnIndex: 1, content: "Description", kind: "columnHeader" },
        { rowIndex: 0, columnIndex: 2, content: "Amount", kind: "columnHeader" },
        { rowIndex: 1, columnIndex: 0, content: "01 Apr" },
        { rowIndex: 1, columnIndex: 1, content: "Fnb App Payment From" },
        { rowIndex: 1, columnIndex: 2, content: "1200.00" },
        { rowIndex: 2, columnIndex: 1, content: "J SMITH TRADING CC" },
      ],
    } as never,
    [],
  );
  const { rows, joined } = rowsFromTable(table);
  assert.equal(joined, 0, "an unjoined wrapped line is cosmetic; a wrong join destroys two transactions");
  assert.equal(rows.length, 2);
});

test("joins into one parent are capped", () => {
  const wrapped = Array.from({ length: MAX_JOINS_PER_ROW + 2 }, (_, i) => ({
    description: `LINE ${i}`,
    top: 1.5 + i * 0.5,
    bottom: 1.9 + i * 0.5,
  }));
  const table = statementTable([
    { date: "01 Apr", description: "PARENT", amount: "1200.00", top: 1, bottom: 1.4 },
    ...wrapped,
  ]);
  const { rows, joined } = rowsFromTable(table);
  assert.equal(joined, MAX_JOINS_PER_ROW, "the cap holds");
  assert.equal(rows.length, 1 + (wrapped.length - MAX_JOINS_PER_ROW), "the overflow stays as its own rows");
});

test("continuation candidacy is decided by money, not by date", () => {
  assert.equal(isContinuationCandidate({ description: "WRAPPED" }), true);
  assert.equal(isContinuationCandidate({ description: "REAL", amount: "10.00" }), false, "has money ⇒ transaction");
  assert.equal(isContinuationCandidate({ description: "REAL", balance: "10.00" }), false);
  assert.equal(isContinuationCandidate({ description: "REAL", debit: "10.00" }), false);
  assert.equal(isContinuationCandidate({ date: "01 Apr", description: "REAL" }), false, "has a date ⇒ transaction");
  assert.equal(isContinuationCandidate({ description: "   " }), false, "blank description is not a continuation");
});

test("only the transaction table yields rows", () => {
  const fees = normalizeTable(
    {
      rowCount: 2, columnCount: 2,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: "Fee Type", kind: "columnHeader" },
        { rowIndex: 0, columnIndex: 1, content: "Amount", kind: "columnHeader" },
        { rowIndex: 1, columnIndex: 0, content: "Monthly account fee" },
        { rowIndex: 1, columnIndex: 1, content: "115.00" },
      ],
    } as never,
    [],
  );
  assert.deepEqual(rowsFromTable(fees), { rows: [], joined: 0 }, "a fee schedule is not the ledger");
});

test("row confidence is the minimum across its cells", () => {
  const table = normalizeTable(
    {
      rowCount: 2, columnCount: 2,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: "Date", kind: "columnHeader" },
        { rowIndex: 0, columnIndex: 1, content: "Amount", kind: "columnHeader" },
        { rowIndex: 1, columnIndex: 0, content: "01 Apr", spans: [{ offset: 0, length: 6 }] },
        { rowIndex: 1, columnIndex: 1, content: "10.00", spans: [{ offset: 7, length: 5 }] },
      ],
    } as never,
    [
      { content: "01 Apr", confidence: 0.99, span: { offset: 0, length: 6 } },
      { content: "10.00", confidence: 0.31, span: { offset: 7, length: 5 } },
    ] as never,
  );
  const { rows } = rowsFromTable(table);
  assert.equal(rows[0].confidence, 0.31);
});

// ── Layout ───────────────────────────────────────────────────────────────────

test("paragraph roles drive furniture removal, and unknown roles stay content", () => {
  const blocks = toLayoutBlocks([
    { role: "pageHeader", content: "FNB Business", boundingRegions: region(1, 0, 0, 9, 0.5) },
    { content: "01 Apr PURCHASE 10.00", boundingRegions: region(1, 0, 1, 9, 1.5) },
    { role: "footnote", content: "Terms apply", boundingRegions: region(1, 0, 2, 9, 2.5) },
    { role: "pageFooter", content: "Page 1 of 4", boundingRegions: region(1, 0, 10, 9, 10.5) },
    { role: "pageNumber", content: "1", boundingRegions: region(1, 4, 11, 5, 11.5) },
  ] as never);

  assert.deepEqual(blocks.map((b) => b.role), ["pageHeader", "paragraph", "paragraph", "pageFooter", "pageNumber"]);
  assert.equal(blocks[2].role, "paragraph", "an unrecognised role is content — mapping it to furniture would delete text");
  assert.deepEqual(blocks.map((b) => b.order), [0, 1, 2, 3, 4], "reading order is explicit, not array position");

  assert.deepEqual(contentBlocks(blocks).map((b) => b.content), ["01 Apr PURCHASE 10.00", "Terms apply"]);
  assert.equal(textFromLayout(blocks), "01 Apr PURCHASE 10.00\nTerms apply");
});

// ── Assembly ─────────────────────────────────────────────────────────────────

const ANALYZE_FIXTURE = {
  content: "01 Apr PURCHASE 10.00 990.00",
  pages: [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", angle: 0, words: [], spans: [{ offset: 0, length: 28 }] }],
  paragraphs: [
    { role: "pageHeader", content: "FNB", boundingRegions: region(1, 0, 0, 9, 0.5) },
    { content: "01 Apr PURCHASE 10.00 990.00", boundingRegions: region(1, 0, 1, 9, 1.5) },
  ],
  tables: [
    {
      rowCount: 2, columnCount: 3, boundingRegions: region(1, 0, 0, 9, 5),
      cells: [
        { rowIndex: 0, columnIndex: 0, content: "Date", kind: "columnHeader" },
        { rowIndex: 0, columnIndex: 1, content: "Description", kind: "columnHeader" },
        { rowIndex: 0, columnIndex: 2, content: "Balance", kind: "columnHeader" },
        { rowIndex: 1, columnIndex: 0, content: "01 Apr", boundingRegions: region(1, 0, 1, 1, 1.4) },
        { rowIndex: 1, columnIndex: 1, content: "PURCHASE", boundingRegions: region(1, 1.2, 1, 6, 1.4) },
        { rowIndex: 1, columnIndex: 2, content: "990.00", boundingRegions: region(1, 8, 1, 9, 1.4) },
      ],
    },
  ],
};

test("buildStructured reports what was recovered, descriptively", () => {
  const structured = buildStructured(ANALYZE_FIXTURE as never);
  assert.equal(structured.tables.length, 1);
  assert.equal(structured.rows.length, 1);
  assert.equal(structured.pageMeta.length, 1);
  assert.deepEqual(structured.quality.resolvedRoles.sort(), ["balance", "date", "description"]);
  assert.equal(structured.quality.transactionTableCount, 1);
  assert.equal(structured.quality.rowContinuity, 1, "the single row has a date and a balance");
  assert.equal(structured.quality.droppedFurnitureCount, 1);
});

test("an empty analyzeResult yields empty structure, not a throw", () => {
  const structured = buildStructured({} as never);
  assert.deepEqual(structured.tables, []);
  assert.deepEqual(structured.rows, []);
  assert.equal(structured.quality.rowContinuity, 0);
  assert.equal(structuredSummary(undefined), null);
});

test("the summary is counts only — no geometry, no cell text", () => {
  const summary = structuredSummary(buildStructured(ANALYZE_FIXTURE as never));
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("PURCHASE"), "cell text must never reach the summary");
  assert.ok(!serialized.includes("polygon"), "geometry must never reach the summary");
  assert.equal(typeof summary?.rowCount, "number");
});

// ── Provider integration: additive, and nothing else moved ───────────────────

test("the provider attaches structure WITHOUT changing any existing field", async () => {
  const f = scriptFetch([accepted202(), succeeded(ANALYZE_FIXTURE)]);
  try {
    const result = await withEnv(
      { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY, AZURE_DOCUMENT_INTELLIGENCE_POLL_MS: "1" },
      () => azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"),
    );
    assert.ok(result);
    // The pre-phase-2 contract, unchanged.
    assert.equal(result.parser, "azure_di");
    assert.equal(result.combinedText, ANALYZE_FIXTURE.content, "text still comes from analyze.content, not from layout");
    assert.equal(result.pageCount, 1);
    assert.equal(result.warnings.length, 0);
    // The addition.
    assert.ok(result.structured, "structure is attached");
    assert.equal(result.structured?.rows.length, 1);
    assert.equal(result.structured?.tables[0].headers[0].role, "date");
  } finally {
    f.restore();
  }
});

test("a failed analysis carries no structure and still fails the same way", async () => {
  const f = scriptFetch([new Response("quota exceeded", { status: 429 })]);
  try {
    const result = await withEnv(
      { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY },
      () => azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"),
    );
    assert.ok(result);
    assert.equal(result.structured, undefined);
    assert.equal(result.combinedText, "");
    assert.equal(result.transactions.length, 0);
  } finally {
    f.restore();
  }
});
