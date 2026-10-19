// Public pages must not advertise security controls the product does not have.
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
];

for (const page of PUBLIC_PAGES) {
  test(`${page} makes no unsupported security claim`, () => {
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
