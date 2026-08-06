// Azure paragraphs → LayoutBlock[], in reading order, with the roles that let
// page furniture be dropped.
//
// This is what replaces the FNB parser's strip_fnb_page_artifacts /
// is_fnb_page_artifact heuristics for Azure-sourced text: Azure already knows a
// line is a running header, so guessing from its content is unnecessary. The
// heuristics stay in place for every other provider and as the fallback here.
import type { LayoutBlock } from "@/lib/pdf/types";
import type { AzureAnalyzeResult, AzureParagraph } from "@/lib/pdf/azure/azureTypes";
import { regionOf } from "@/lib/pdf/azure/azureTypes";

const KNOWN_ROLES = new Set(["title", "sectionHeading", "pageHeader", "pageFooter", "pageNumber"]);

/** Roles that are page furniture rather than statement content. */
export const FURNITURE_ROLES: ReadonlyArray<LayoutBlock["role"]> = ["pageHeader", "pageFooter", "pageNumber"];

function normalizeRole(role: string | undefined): LayoutBlock["role"] {
  // Anything unrecognised — including Azure's "footnote" and "formulaBlock", and
  // the common case of no role at all — is body text. Mapping an unknown role to
  // furniture would silently delete content.
  return role && KNOWN_ROLES.has(role) ? (role as LayoutBlock["role"]) : "paragraph";
}

/**
 * Reading order is the order Azure returns paragraphs in — it is already
 * sorted by reading order within each page, and by page across the document.
 * The index is recorded explicitly so downstream consumers do not depend on
 * array position surviving a filter.
 */
export function toLayoutBlocks(paragraphs: AzureParagraph[] | undefined): LayoutBlock[] {
  return (Array.isArray(paragraphs) ? paragraphs : []).map((paragraph, index) => {
    const region = regionOf(paragraph.boundingRegions);
    return {
      order: index,
      role: normalizeRole(paragraph.role),
      content: String(paragraph.content ?? "").trim(),
      pageNumber: region?.pageNumber ?? 1,
      region,
    };
  });
}

export function isFurniture(block: LayoutBlock): boolean {
  return FURNITURE_ROLES.includes(block.role);
}

/** Content blocks with page furniture removed, in reading order. */
export function contentBlocks(blocks: LayoutBlock[]): LayoutBlock[] {
  return blocks.filter((block) => !isFurniture(block) && block.content.length > 0);
}

/**
 * Text rebuilt from layout with furniture dropped.
 *
 * NOT yet used as the extraction's combinedText. Swapping the text the FNB
 * parser sees is a behaviour change and belongs to phase 3/4 — at that point it
 * must be chosen by yield, the same rule the pipeline already applies to text
 * selection. Exposed here so the comparison can be measured first.
 */
export function textFromLayout(blocks: LayoutBlock[]): string {
  return contentBlocks(blocks)
    .map((block) => block.content)
    .join("\n");
}

export function buildLayout(analyze: AzureAnalyzeResult): LayoutBlock[] {
  return toLayoutBlocks(analyze.paragraphs);
}
