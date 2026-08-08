import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const { merchantKeyRejection, isSafeMerchantKey } = await import("@/lib/accounting/merchant-keys.ts");

// Production: the key "d" — normalised from the alias "mr d" of the seeded
// merchant "Mr D Food" — matched 425 of 615 rows on a real 37-page statement.

test("both languages enforce one policy file", () => {
  const shared = JSON.parse(read("workers/accounting_worker/engine/merchant_key_policy.json"));
  const worker = read("workers/accounting_worker/engine/merchant_keys.py");
  const ts = read("lib/accounting/merchant-keys.ts");
  assert.match(worker, /merchant_key_policy\.json/, "the worker reads the shared policy");
  assert.match(ts, /merchant_key_policy\.json/, "TypeScript reads the same file");
  assert.ok(shared.stoplist.length > 20, "the stoplist is populated");
});

test("a key must be able to identify a counterparty", () => {
  for (const unsafe of ["d", "mr", "mr d", "inv", "account fee", "transfer to credit card", "payment", ""]) {
    assert.equal(isSafeMerchantKey(unsafe), false, `${unsafe} must be rejected`);
    assert.ok(merchantKeyRejection(unsafe), `${unsafe} must carry a reason`);
  }
  // Length alone cannot judge: AWS and DHL are real merchants at three chars.
  // Domain words naming a real transaction class stay accepted.
  for (const safe of ["aws", "dhl", "mr d food", "woolworths", "uber eats", "msi industries", "salary", "sars"]) {
    assert.equal(isSafeMerchantKey(safe), true, `${safe} must be accepted (${merchantKeyRejection(safe)})`);
  }
});

test("normalisation no longer eats words beginning with m", () => {
  const server = read("lib/accounting/server.ts");
  assert.ok(!/\(\?:inv\|invoice\|ref\|rmsp\|m\)/.test(server), "the bare m alternative is gone");
  assert.match(server, /\\bm\\d\[\\w-\]\*\\b/, "an m-prefixed reference still requires a digit");
});

test("both rule-creation paths validate the key", () => {
  const server = read("lib/accounting/server.ts");
  assert.match(server, /merchantKeyRejection\(rule\.merchantKey\)/, "the seeding path validates");
  assert.match(server, /const safeMerchantKeys = learningMerchantKeys\.filter/, "the correction path validates");
  assert.match(server, /safeMerchantKeys\.map\(\(key\) => \(\{/, "and only safe keys are written");
});
