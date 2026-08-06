// StructuredTable → StructuredRow[], including geometry-confirmed joining of
// wrapped descriptions.
//
// Only tables that identify as the transaction ledger produce rows; a summary or
// fee-schedule table yields none. Rows are built from the provider's own cell
// segmentation, so a merchant name arrives exactly as Azure grouped it rather
// than re-tokenised out of flattened text.
import type { ColumnRole, Region, StructuredRow, StructuredTable } from "@/lib/pdf/types";
import { MONEY_ROLES, isTransactionTable } from "@/lib/pdf/azure/columnRoles";
import { extentOf, heightOf, horizontalOverlap, median, verticalGap } from "@/lib/pdf/azure/geometry";
import { pdfLog } from "@/lib/pdf/log";

/**
 * A continuation must start within this multiple of the median row height below
 * its parent. Derived from the page's own rows, so it scales with DPI and page
 * size instead of being a pixel constant.
 */
export const CONTINUATION_GAP_RATIO = 0.75;

/** Minimum horizontal overlap with the parent's description cell. */
export const CONTINUATION_MIN_OVERLAP = 0.5;

/** Most continuation rows that may fold into one parent (risk: over-merging). */
export const MAX_JOINS_PER_ROW = 3;

type DraftRow = {
  rowIndex: number;
  pageNumber: number;
  cells: Partial<Record<ColumnRole, string | null>>;
  /** Region of the description cell alone — what a wrapped line aligns to. */
  descriptionRegion: Region | undefined;
  region: Region | undefined;
  confidence: number | null;
  order: string[];
};

/** Axis-aligned polygon covering every supplied region on one page. */
function unionRegion(regions: Array<Region | undefined>, pageNumber: number): Region | undefined {
  const extents = regions.map((r) => extentOf(r)).filter((e): e is NonNullable<typeof e> => e !== null);
  if (!extents.length) return undefined;
  const top = Math.min(...extents.map((e) => e.top));
  const bottom = Math.max(...extents.map((e) => e.bottom));
  const left = Math.min(...extents.map((e) => e.left));
  const right = Math.max(...extents.map((e) => e.right));
  return { pageNumber, polygon: [left, top, right, top, right, bottom, left, bottom] };
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when the row carries a value in any money column. */
export function hasMoney(cells: Partial<Record<ColumnRole, string | null>>): boolean {
  return MONEY_ROLES.some((role) => hasText(cells[role]));
}

/**
 * Is this row a wrapped continuation of the one above it?
 *
 * DELIBERATE DEVIATION from the plan's §4b, which said "date cell empty but
 * description populated" is a continuation candidate. On an FNB statement that
 * rule is actively wrong: FNB prints the date ONCE per date group and every
 * later transaction in the group — debit orders, app payments, fee lines — has
 * no date of its own. Those are real transactions, and folding them into the
 * previous description is the exact defect the ACAPOLITE regression fixture
 * exists to catch (6 debits, R29,912.54, lost to a reconciliation failure).
 *
 * The discriminator is money, not date: a wrapped description carries no amount.
 * So a row qualifies only when it has no date, no value in ANY money column, and
 * some description text.
 */
export function isContinuationCandidate(cells: Partial<Record<ColumnRole, string | null>>): boolean {
  if (hasText(cells.date)) return false;
  if (hasMoney(cells)) return false;
  return hasText(cells.description);
}

function buildDraftRows(table: StructuredTable): DraftRow[] {
  const roleByColumn = new Map<number, ColumnRole>();
  for (const header of table.headers) roleByColumn.set(header.index, header.role);

  // Rows consisting entirely of header cells are the header, not data.
  const headerRows = new Set<number>();
  const cellsByRow = new Map<number, typeof table.cells>();
  for (const cell of table.cells) {
    const list = cellsByRow.get(cell.rowIndex) ?? [];
    list.push(cell);
    cellsByRow.set(cell.rowIndex, list);
  }
  for (const [rowIndex, cells] of cellsByRow) {
    if (cells.length && cells.every((c) => c.kind === "columnHeader")) headerRows.add(rowIndex);
  }

  const drafts: DraftRow[] = [];
  for (const rowIndex of [...cellsByRow.keys()].sort((a, b) => a - b)) {
    if (headerRows.has(rowIndex)) continue;
    const cells = cellsByRow.get(rowIndex) ?? [];

    const values: Partial<Record<ColumnRole, string | null>> = {};
    const order: string[] = [];
    const confidences: number[] = [];
    const regions: Array<Region | undefined> = [];
    let descriptionRegion: Region | undefined;

    for (const cell of [...cells].sort((a, b) => a.columnIndex - b.columnIndex)) {
      // A cell spanning several columns is attributed to the column it STARTS
      // in — its header is the one that names it.
      const role = roleByColumn.get(cell.columnIndex) ?? "unknown";
      const content = cell.content.trim();
      if (content) order.push(content);
      if (role !== "unknown") {
        // Two cells mapping to one role (a split description) concatenate rather
        // than overwrite, so no text is silently dropped.
        const existing = values[role];
        values[role] = hasText(existing) && content ? `${existing} ${content}` : content || existing || null;
        if (role === "description" && cell.region) {
          descriptionRegion = descriptionRegion ? unionRegion([descriptionRegion, cell.region], cell.region.pageNumber) : cell.region;
        }
      }
      if (typeof cell.confidence === "number") confidences.push(cell.confidence);
      regions.push(cell.region);
    }

    const pageNumber = cells.find((c) => c.region)?.region?.pageNumber ?? table.pageNumber;
    drafts.push({
      rowIndex,
      pageNumber,
      cells: values,
      descriptionRegion,
      region: unionRegion(regions, pageNumber),
      confidence: confidences.length ? Math.min(...confidences) : null,
      order,
    });
  }
  return drafts;
}

export type RowsResult = { rows: StructuredRow[]; joined: number };

/**
 * Confirm a continuation by geometry (§4b step 2): the candidate must sit
 * directly beneath its parent, within a tolerance derived from the median row
 * height, and be horizontally aligned to the description column.
 *
 * Geometry is CONFIRMATION, not the trigger. When polygons are absent the join
 * is refused rather than assumed — an unjoined wrapped line is a cosmetic defect,
 * a wrongly joined pair destroys two transactions.
 */
function joinConfirmedByGeometry(parent: DraftRow, candidate: DraftRow, tolerance: number | null): boolean {
  if (parent.pageNumber !== candidate.pageNumber) return false;
  if (tolerance === null) return false;
  const gap = verticalGap(parent.region, candidate.region);
  if (gap === null) return false;
  // Negative gap means they overlap vertically — that is the same visual line,
  // not a wrapped one.
  if (gap < 0 || gap > tolerance) return false;
  const overlap = horizontalOverlap(parent.descriptionRegion, candidate.descriptionRegion);
  if (overlap === null) return false;
  return overlap >= CONTINUATION_MIN_OVERLAP;
}

export function rowsFromTable(table: StructuredTable): RowsResult {
  if (!isTransactionTable(table.headers)) return { rows: [], joined: 0 };

  const drafts = buildDraftRows(table);
  const rowHeights = drafts.map((d) => heightOf(d.region)).filter((h): h is number => h !== null && h > 0);
  const medianHeight = median(rowHeights);
  const tolerance = medianHeight === null ? null : medianHeight * CONTINUATION_GAP_RATIO;

  const rows: StructuredRow[] = [];
  // The draft each emitted row came from, so a candidate can be measured against
  // its parent's geometry, and how many lines have already folded into it.
  const parents: DraftRow[] = [];
  const joinCounts: number[] = [];
  let joined = 0;

  for (const draft of drafts) {
    const last = rows.length - 1;
    const canJoin =
      last >= 0 &&
      isContinuationCandidate(draft.cells) &&
      joinCounts[last] < MAX_JOINS_PER_ROW &&
      joinConfirmedByGeometry(parents[last], draft, tolerance);

    if (canJoin) {
      // Join with a single space and PRESERVE the merchant string as Azure
      // grouped it — no re-tokenising, no punctuation repair.
      const addition = String(draft.cells.description ?? "").trim();
      const base = String(rows[last].cells.description ?? "").trim();
      rows[last].cells.description = base ? `${base} ${addition}` : addition;
      rows[last].raw = `${rows[last].raw} ${addition}`.trim();
      rows[last].confidence =
        rows[last].confidence === null
          ? draft.confidence
          : draft.confidence === null
            ? rows[last].confidence
            : Math.min(rows[last].confidence as number, draft.confidence);
      rows[last].region = unionRegion([rows[last].region, draft.region], rows[last].pageNumber);
      rows[last].absorbedRows = [...(rows[last].absorbedRows ?? []), draft.rowIndex];
      joinCounts[last] += 1;
      joined += 1;
      // Every join is logged, content-free, so over-merging is diagnosable.
      pdfLog("azure.structured.row_joined", {
        page: draft.pageNumber,
        parentRow: parents[last].rowIndex,
        joinedRow: draft.rowIndex,
        addedChars: addition.length,
        joinsIntoParent: joinCounts[last],
      });
      continue;
    }

    rows.push({
      pageNumber: draft.pageNumber,
      cells: draft.cells,
      raw: draft.order.join(" ").trim(),
      confidence: draft.confidence,
      region: draft.region,
    });
    parents.push(draft);
    joinCounts.push(0);
  }

  return { rows, joined };
}

/** Every transaction table in the document, in order. */
export function rowsFromTables(tables: StructuredTable[]): RowsResult {
  const rows: StructuredRow[] = [];
  let joined = 0;
  for (const table of tables) {
    const result = rowsFromTable(table);
    rows.push(...result.rows);
    joined += result.joined;
  }
  return { rows, joined };
}

/** Rows carrying a date and at least one amount, over total rows. 0..1. */
export function rowContinuity(rows: StructuredRow[]): number {
  if (!rows.length) return 0;
  const complete = rows.filter((row) => hasText(row.cells.date) && hasMoney(row.cells)).length;
  return complete / rows.length;
}
