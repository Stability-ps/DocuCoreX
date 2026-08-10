import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  CURRENCY_SYMBOLS,
  DEFAULT_STATEMENT_CURRENCY,
  currencySymbol,
  formatCount,
  formatMoney,
  formatStatementDate,
  maskAccountNumber,
} from "../../lib/accounting/format.ts";

test("the currencies the brief names all render with their own symbol", () => {
  assert.equal(formatMoney(1234.5, "ZAR"), "R1,234.50");
  assert.equal(formatMoney(1234.5, "USD"), "$1,234.50");
  assert.equal(formatMoney(1234.5, "GBP"), "£1,234.50");
  assert.equal(formatMoney(1234.5, "EUR"), "€1,234.50");
  assert.equal(formatMoney(1234.5, "AUD"), "A$1,234.50");
});

test("an unknown currency shows its code rather than a guessed glyph", () => {
  // "SEK 1,234.50" is unambiguous. Inventing a symbol, or dropping the currency
  // entirely, would both be worse than saying the code.
  assert.equal(formatMoney(1234.5, "SEK"), "SEK 1,234.50");
  assert.equal(currencySymbol("XYZ"), "XYZ");
});

test("currency codes are case-insensitive", () => {
  assert.equal(formatMoney(10, "usd"), "$10.00");
});

test("no currency falls back to the stated default, not to nothing", () => {
  assert.equal(formatMoney(10), formatMoney(10, DEFAULT_STATEMENT_CURRENCY));
  assert.equal(currencySymbol(null), CURRENCY_SYMBOLS[DEFAULT_STATEMENT_CURRENCY]);
  // The fallback is named and exported so it reads as an assumption.
  assert.equal(typeof DEFAULT_STATEMENT_CURRENCY, "string");
});

test("the minus leads the whole figure, as a statement prints it", () => {
  // "-R1,234.56", not "R-1,234.56" — an overdrawn balance is a negative amount
  // of money, not a negative quantity of rands.
  assert.equal(formatMoney(-1234.56, "ZAR"), "-R1,234.56");
  assert.equal(formatMoney(-1234.56, "USD"), "-$1,234.56");
});

test("absolute suppresses the sign without changing the number", () => {
  assert.equal(formatMoney(-992832.57, "ZAR", { absolute: true }), "R992,832.57");
});

test("decimals can be dropped for summary figures", () => {
  assert.equal(formatMoney(1234.56, "ZAR", { decimals: 0 }), "R1,235");
});

test("null and undefined are zero, not a crash", () => {
  assert.equal(formatMoney(null, "USD"), "$0.00");
  assert.equal(formatMoney(undefined, "USD"), "$0.00");
  assert.equal(formatCount(null), "0");
});

test("grouping is fixed, so the server and the browser agree", () => {
  // Intl with an undefined locale resolves differently on the server and in the
  // browser, and Next.js renders both — that is a hydration mismatch on every
  // amount on the page. A fixed locale also keeps the figure comparable with a
  // printed statement.
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatMoney(1234567.89, "USD"), "$1,234,567.89");
});

test("statement dates avoid the ambiguity that matters most here", () => {
  // 04/05/2025 is 4 May in London and 5 April in New York. On a bank statement
  // that ambiguity is expensive, so the month is always named.
  assert.equal(formatStatementDate("2025-04-30"), "30 Apr 2025");
  assert.equal(formatStatementDate(null), "—");
  // An unparseable value is echoed rather than replaced with a wrong date.
  assert.equal(formatStatementDate("not a date"), "not a date");
});

test("account masking is country-neutral", () => {
  // Last four of whatever the bank printed, whether that is a South African
  // account number or a UK sort code and account.
  assert.equal(maskAccountNumber("1234567890"), "•••• 7890");
  assert.equal(maskAccountNumber("12-34-56 87654321"), "•••• 4321");
  assert.equal(maskAccountNumber("123"), "123", "too short to mask meaningfully");
  assert.equal(maskAccountNumber(null), null);
});

test("the accounting UI no longer hard-codes a country's locale", () => {
  // The regression this whole change exists to prevent: "en-ZA" and a bare "R"
  // written inline across five components made the product structurally South
  // African, because shipping elsewhere meant finding every one of them.
  for (const file of [
    "components/accounting/accounting-intelligence.tsx",
    "components/accounting/statement-workspace.tsx",
    "components/accounting/workspace-insights.tsx",
    "components/accounting/workspace-forecast.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!/["']en-ZA["']/.test(source), `${file} must not pin a locale`);
  }
});

test("no hard-coded bank roster remains in the workspace", () => {
  const source = readFileSync("components/accounting/accounting-intelligence.tsx", "utf8");
  assert.ok(!/supportedBanks/.test(source), "the bank chip roster is gone");
  assert.ok(!/Select Bank/.test(source), "the bank selector is gone");
  assert.ok(!/FNB South Africa/.test(source), "no institution is the default identity");
  // "All Banks" would be a claim the backend cannot honour.
  assert.ok(!/All Banks|Every Bank|Any Bank/i.test(source), "no universal-support claim");
});

test("internal identifiers are untouched", () => {
  // Branding must not drive a backend rename. The route stays; only what the
  // user sees changed.
  const source = readFileSync("components/accounting/accounting-intelligence.tsx", "utf8");
  assert.ok(/\/api\/accounting\/fnb\//.test(source), "the FNB route is still called");
});

test("the landing page does not scope the product to one market", () => {
  // #126 globalised the workspace and left this page untouched, so the first
  // thing a prospective customer saw was a grid of ten South African banks and
  // "Optimised for South African banks from day one". A reader whose bank is
  // absent from a named roster concludes the product is not for them.
  const source = readFileSync("app/page.tsx", "utf8");

  for (const bank of ["FNB", "Absa", "Capitec", "Investec", "Nedbank", "TymeBank", "Bidvest", "Discovery Bank"]) {
    assert.ok(!source.includes(bank), `landing page must not name ${bank}`);
  }
  assert.ok(!/South African/i.test(source), "must not scope the product to one country");

  // Replaced with capabilities, not a different roster.
  assert.ok(/statementCapabilities/.test(source), "capabilities replace the bank grid");
});

test("the landing page does not claim currencies the product cannot detect", () => {
  // The UI formats per currency code, but no currency is detected from a
  // statement yet — advertising multi-currency would be a claim the pipeline
  // cannot honour.
  const source = readFileSync("app/page.tsx", "utf8");
  assert.ok(!/multi-currency|any currency|all currencies/i.test(source));
});
