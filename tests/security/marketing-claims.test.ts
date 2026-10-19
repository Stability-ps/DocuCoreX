// Public pages must not advertise security controls or features the product does not have.
// Each pattern below was on the homepage or login page while the feature did not
// exist (2026-10-19 audit). When one of them ships for real, delete its entry
// here in the same PR that ships it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const PUBLIC_PAGES = ["app/page.tsx", "app/login/page.tsx", "app/signup/page.tsx", "lib/product-data.ts"];

const UNSUPPORTED: Array<[RegExp, string]> = [
  [/virus scan/i, "there is no malware scanning (see the remediation tracker)"],
  [/two-factor (authentication|controls) (is|are) built in|two-factor authentication, /i, "2FA is not implemented; settings show it as coming soon"],
  [/99\.9\s*%/, "no uptime SLA or monitoring backs an uptime figure"],
  [/bank-grade/i, "an unverifiable security claim"],
  // Product claims removed on 2026-10-19 because the features do not exist.
  [/\beSign\b|request signatures/i, "there is no e-signature feature"],
  [/Adobe-Class|PDF Editor|Edit PDFs/i, "there is no PDF editor (the viewer is read-only)"],
  // Not Tailwind's "-translate-y-…" classes: the word, as copy.
  [/(?<![-\w])translat(e|ion)s?\b(?!-)/i, "there is no translation"],
  [/invoices and receipts with/i, "reconciliation is against the ledger, not invoices or receipts"],
  [/48\.2k|1\.8M|2\.4 TB|1,284 transactions|field confidence/i, "invented platform figures"],
  [/\/v1\/extractions/, "there is no public extraction API"],
  [/\bXML\b/, "XML is neither a conversion target nor an export format"],
];

for (const page of PUBLIC_PAGES) {
  test(`${page} makes no unsupported claim`, () => {
    let source: string;
    try {
      source = read(page);
    } catch {
      return; // page does not exist in this checkout
    }
    for (const [pattern, why] of UNSUPPORTED) {
      assert.doesNotMatch(source, pattern, `${page}: ${why}`);
    }
  });
}
