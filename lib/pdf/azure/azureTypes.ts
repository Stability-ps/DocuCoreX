// Raw Azure Document Intelligence response shapes (prebuilt-layout, api-version
// 2024-11-30). Widened from what the provider previously declared: it typed only
// the fields it consumed, which is why cells, geometry and confidence had no way
// to reach the pipeline even though Azure was already returning them.
//
// Every field stays OPTIONAL. This is a wire format from a service we do not
// control, and a missing field must degrade the structure rather than throw.

export type AzureSpan = { offset?: number; length?: number };

export type AzureBoundingRegion = { pageNumber?: number; polygon?: number[] };

export type AzureWord = {
  content?: string;
  polygon?: number[];
  confidence?: number;
  span?: AzureSpan;
};

export type AzureLine = { content?: string; polygon?: number[]; spans?: AzureSpan[] };

export type AzurePage = {
  pageNumber?: number;
  angle?: number;
  width?: number;
  height?: number;
  unit?: string;
  words?: AzureWord[];
  lines?: AzureLine[];
  spans?: AzureSpan[];
};

export type AzureTableCell = {
  kind?: "columnHeader" | "rowHeader" | "content" | string;
  rowIndex?: number;
  columnIndex?: number;
  rowSpan?: number;
  columnSpan?: number;
  content?: string;
  boundingRegions?: AzureBoundingRegion[];
  spans?: AzureSpan[];
};

export type AzureTable = {
  rowCount?: number;
  columnCount?: number;
  cells?: AzureTableCell[];
  boundingRegions?: AzureBoundingRegion[];
  spans?: AzureSpan[];
};

/**
 * Azure's paragraph roles. Anything else (including absent, which is the common
 * case for body text) is treated as a plain paragraph.
 */
export type AzureParagraph = {
  role?: "title" | "sectionHeading" | "pageHeader" | "pageFooter" | "pageNumber" | "footnote" | "formulaBlock" | string;
  content?: string;
  boundingRegions?: AzureBoundingRegion[];
  spans?: AzureSpan[];
};

export type AzureAnalyzeResult = {
  content?: string;
  pages?: AzurePage[];
  tables?: AzureTable[];
  paragraphs?: AzureParagraph[];
};

export type AzureOperation = {
  status?: "notStarted" | "running" | "succeeded" | "failed" | string;
  analyzeResult?: AzureAnalyzeResult;
  error?: { code?: string; message?: string };
};

/** First bounding region of an element, as the pipeline's Region. */
export function regionOf(regions: AzureBoundingRegion[] | undefined, fallbackPage = 1) {
  const first = regions?.[0];
  if (!first || !Array.isArray(first.polygon) || first.polygon.length < 8) return undefined;
  return { pageNumber: first.pageNumber ?? fallbackPage, polygon: first.polygon.slice() };
}
