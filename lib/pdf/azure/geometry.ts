// Polygon helpers for Azure bounding regions.
//
// Azure returns a polygon as 8 numbers — 4 corner points, clockwise from
// top-left — in the page's own `unit` (inch for PDF, pixel for images). The
// helpers below never assume the polygon is axis-aligned: a skewed scan gives a
// genuine quadrilateral, so extents are taken as min/max over all four corners
// rather than by reading corner 0 and corner 2.
//
// SKEW: PageMeta.angle is recorded but NOT corrected for here. prebuilt-layout
// already returns polygons in the page's reading orientation, so a second
// rotation would double-apply it. Left as a known limitation rather than a
// silent transform — if a skewed statement ever mis-joins rows, this is the
// first place to look.
import type { Region } from "@/lib/pdf/types";

export type Extent = { top: number; bottom: number; left: number; right: number };

/** Every other y in a polygon, i.e. the corner y-coordinates. */
function ys(polygon: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < polygon.length; i += 2) out.push(polygon[i]);
  return out;
}

function xs(polygon: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < polygon.length; i += 2) out.push(polygon[i]);
  return out;
}

/** Bounding box of a polygon. Null for a malformed or empty polygon. */
export function extentOf(region: Region | undefined | null): Extent | null {
  const polygon = region?.polygon;
  if (!Array.isArray(polygon) || polygon.length < 8 || polygon.length % 2 !== 0) return null;
  if (!polygon.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const y = ys(polygon);
  const x = xs(polygon);
  return { top: Math.min(...y), bottom: Math.max(...y), left: Math.min(...x), right: Math.max(...x) };
}

/** Height of a region, or null when it has no usable polygon. */
export function heightOf(region: Region | undefined | null): number | null {
  const extent = extentOf(region);
  return extent ? extent.bottom - extent.top : null;
}

/** Median of a numeric list. Null when empty. Even-length takes the mean of the middle pair. */
export function median(values: number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!usable.length) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 1 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
}

/**
 * Vertical gap between `below` and `above`: how far the top of `below` sits
 * beneath the bottom of `above`. Negative when they overlap vertically.
 * Null when either lacks a usable polygon.
 */
export function verticalGap(above: Region | undefined | null, below: Region | undefined | null): number | null {
  const a = extentOf(above);
  const b = extentOf(below);
  if (!a || !b) return null;
  return b.top - a.bottom;
}

/** Fraction of the narrower span's width that the two regions share horizontally. 0..1. */
export function horizontalOverlap(left: Region | undefined | null, right: Region | undefined | null): number | null {
  const a = extentOf(left);
  const b = extentOf(right);
  if (!a || !b) return null;
  const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  if (overlap <= 0) return 0;
  const narrower = Math.min(a.right - a.left, b.right - b.left);
  if (narrower <= 0) return 0;
  return Math.min(1, overlap / narrower);
}

/** True when two regions sit on the same page. Regions without a page never match. */
export function samePage(a: Region | undefined | null, b: Region | undefined | null): boolean {
  return Boolean(a && b && a.pageNumber === b.pageNumber);
}
