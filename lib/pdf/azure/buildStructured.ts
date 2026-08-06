// Assemble the StructuredExtraction from one Azure analyzeResult.
//
// PURELY ADDITIVE (phase 2). Nothing here influences extraction, scoring,
// acceptance, the merge, or what the accounting worker receives — the result is
// attached to ExtractionResult.structured and read by no decision. Scoring on it
// is phase 3; sending it to the worker is phase 4.
//
// NOT INCLUDED: keyValues. §4 lists a keyValues.ts module, but key-value pairs
// require the `features=keyValuePairs` add-on, which costs extra per page, and
// §10 question 4 (account number / period already parse reliably from text) is
// still unanswered. Adding the request parameter would start billing for it
// before that decision is made.
import type { StructuredExtraction, StructuredQuality, ColumnRole } from "@/lib/pdf/types";
import type { AzureAnalyzeResult } from "@/lib/pdf/azure/azureTypes";
import { isTransactionTable } from "@/lib/pdf/azure/columnRoles";
import { buildLayout, isFurniture } from "@/lib/pdf/azure/layout";
import { normalizeTables, toPageMeta } from "@/lib/pdf/azure/normalizeTables";
import { rowContinuity, rowsFromTables } from "@/lib/pdf/azure/rowsFromTables";

export function buildStructured(analyze: AzureAnalyzeResult): StructuredExtraction {
  const pages = Array.isArray(analyze.pages) ? analyze.pages : [];
  const tables = normalizeTables(analyze);
  const layout = buildLayout(analyze);
  const { rows, joined } = rowsFromTables(tables);

  const resolvedRoles = [
    ...new Set(
      tables
        .flatMap((table) => table.headers.map((header) => header.role))
        .filter((role): role is ColumnRole => role !== "unknown"),
    ),
  ];

  const quality: StructuredQuality = {
    tableCount: tables.length,
    transactionTableCount: tables.filter((table) => isTransactionTable(table.headers)).length,
    rowCount: rows.length,
    rowContinuity: Number(rowContinuity(rows).toFixed(4)),
    resolvedRoles,
    joinedRowCount: joined,
    droppedFurnitureCount: layout.filter(isFurniture).length,
  };

  return { tables, rows, layout, pageMeta: toPageMeta(pages), quality };
}

/**
 * Content-free summary for logs and (in phase 6) `structured_summary`.
 *
 * Counts and ratios only — never geometry, never cell text. Full layout with
 * polygons for a multi-page statement runs to megabytes; persisting it per run
 * would bloat every query that selects `*`.
 */
export function structuredSummary(structured: StructuredExtraction | undefined) {
  if (!structured) return null;
  return {
    ...structured.quality,
    pageCount: structured.pageMeta.length,
    layoutBlocks: structured.layout.length,
  };
}
