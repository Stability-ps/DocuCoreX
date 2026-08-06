// Azure table cells → StructuredTable, keeping everything the flat
// `string[][]` shape discarded: spans, per-cell geometry, merged-cell extents
// and per-cell confidence.
import type { PageMeta, Region, StructuredCell, StructuredTable } from "@/lib/pdf/types";
import type { AzureAnalyzeResult, AzurePage, AzureTable, AzureWord } from "@/lib/pdf/azure/azureTypes";
import { regionOf } from "@/lib/pdf/azure/azureTypes";
import { resolveColumnRoles } from "@/lib/pdf/azure/columnRoles";

/**
 * Per-cell confidence, as the MINIMUM word confidence inside the cell (§4d).
 *
 * Minimum, not mean: the point is to flag a specific misread amount. Averaging a
 * cell containing one garbled digit against five clean ones hides exactly the
 * case worth surfacing.
 *
 * Words are matched to cells by character span against Azure's flat `content`
 * offsets, which is the only linkage the API provides — cells carry `spans`,
 * words carry a `span`, and both index the same string.
 */
export function cellConfidence(cellSpans: Array<{ offset?: number; length?: number }> | undefined, words: AzureWord[]): number | null {
  const ranges = (cellSpans ?? [])
    .map((s) => ({ start: s.offset ?? -1, end: (s.offset ?? -1) + (s.length ?? 0) }))
    .filter((r) => r.start >= 0 && r.end > r.start);
  if (!ranges.length) return null;

  let min: number | null = null;
  for (const word of words) {
    const start = word.span?.offset;
    if (typeof start !== "number" || typeof word.confidence !== "number" || !Number.isFinite(word.confidence)) continue;
    const end = start + (word.span?.length ?? 0);
    // A word belongs to the cell when its span starts inside one of the cell's
    // ranges. Start-only is sufficient: Azure never splits a word across cells.
    const inside = ranges.some((r) => start >= r.start && start < r.end && end <= r.end + 1);
    if (!inside) continue;
    min = min === null ? word.confidence : Math.min(min, word.confidence);
  }
  return min;
}

/** All words on the document, flattened once so cell matching is not O(pages·cells). */
export function collectWords(pages: AzurePage[]): AzureWord[] {
  const out: AzureWord[] = [];
  for (const page of pages) {
    for (const word of page.words ?? []) out.push(word);
  }
  return out;
}

/** Page metadata, needed to interpret polygon units and to record detected skew. */
export function toPageMeta(pages: AzurePage[]): PageMeta[] {
  return pages.map((page, index) => ({
    pageNumber: page.pageNumber ?? index + 1,
    width: typeof page.width === "number" ? page.width : 0,
    height: typeof page.height === "number" ? page.height : 0,
    unit: typeof page.unit === "string" ? page.unit : "",
    angle: typeof page.angle === "number" ? page.angle : 0,
  }));
}

function normalizeKind(kind: string | undefined): StructuredCell["kind"] {
  return kind === "columnHeader" || kind === "rowHeader" || kind === "content" ? kind : undefined;
}

/** One Azure table → StructuredTable. Cells with no usable index are dropped. */
export function normalizeTable(table: AzureTable, words: AzureWord[]): StructuredTable {
  const tableRegion = regionOf(table.boundingRegions);
  const pageNumber = tableRegion?.pageNumber ?? 1;

  const cells: StructuredCell[] = [];
  for (const cell of table.cells ?? []) {
    const rowIndex = cell.rowIndex ?? 0;
    const columnIndex = cell.columnIndex ?? 0;
    if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex) || rowIndex < 0 || columnIndex < 0) continue;
    const region: Region | undefined = regionOf(cell.boundingRegions, pageNumber);
    cells.push({
      rowIndex,
      columnIndex,
      // Azure omits the span fields when they are 1; a missing value is not 0.
      rowSpan: Math.max(1, cell.rowSpan ?? 1),
      columnSpan: Math.max(1, cell.columnSpan ?? 1),
      content: String(cell.content ?? "").trim(),
      kind: normalizeKind(cell.kind),
      confidence: cellConfidence(cell.spans, words),
      region,
    });
  }

  // Trust the declared counts, but never let them cut off a cell that exists —
  // a truncated table silently loses transactions.
  const maxRow = cells.reduce((m, c) => Math.max(m, c.rowIndex + c.rowSpan), 0);
  const maxCol = cells.reduce((m, c) => Math.max(m, c.columnIndex + c.columnSpan), 0);
  const rowCount = Math.max(table.rowCount ?? 0, maxRow);
  const columnCount = Math.max(table.columnCount ?? 0, maxCol);

  return {
    pageNumber,
    rowCount,
    columnCount,
    headers: resolveColumnRoles(cells, columnCount),
    cells,
    region: tableRegion,
  };
}

export function normalizeTables(analyze: AzureAnalyzeResult): StructuredTable[] {
  const words = collectWords(Array.isArray(analyze.pages) ? analyze.pages : []);
  return (Array.isArray(analyze.tables) ? analyze.tables : []).map((table) => normalizeTable(table, words));
}
