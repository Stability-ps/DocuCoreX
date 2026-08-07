import type { VatTreatment } from "@/lib/accounting/types";
import { CANONICAL_CATEGORIES } from "@/lib/accounting/categories";

export {
  CANONICAL_CATEGORIES,
  CATEGORY_OPTIONS,
  canonicaliseCategory,
  categoryLabel,
  categoryOptionsFor,
  isKnownCategory,
} from "@/lib/accounting/categories";

/**
 * DEPRECATED as a hand-maintained list. Re-exported from the canonical
 * vocabulary so the dropdown, the worker, AI validation and learned rules can
 * no longer disagree about what a category is. Prefer CATEGORY_OPTIONS, which
 * carries the human label alongside the stored value.
 */
export const ACCOUNTING_CATEGORY_OPTIONS = CANONICAL_CATEGORIES;

export const VAT_TREATMENT_OPTIONS: Array<{ value: VatTreatment; label: string }> = [
  { value: "standard", label: "Standard VAT" },
  { value: "zero_rated", label: "Zero-rated" },
  { value: "exempt", label: "Exempt" },
  { value: "out_of_scope", label: "Out of scope" },
  { value: "review", label: "Review" },
];

export function isUnresolvedAccountingCategory(category: string) {
  return /uncategori|review|required|suspense/i.test(category);
}
