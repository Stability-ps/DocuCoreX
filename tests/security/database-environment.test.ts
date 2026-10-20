// Local development refuses the production database unless explicitly allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { productionDatabaseRefusal, supabaseProjectRef, PRODUCTION_SUPABASE_PROJECT_REF, ALLOW_PRODUCTION_DATABASE_FLAG } = await import(
  "../../lib/database-environment.ts"
);

const PROD_URL = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
const DEV_URL = "https://abcdefghijklmnopqrst.supabase.co";

test("reads the project ref from a Supabase URL", () => {
  assert.equal(supabaseProjectRef(PROD_URL), PRODUCTION_SUPABASE_PROJECT_REF);
  assert.equal(supabaseProjectRef(`${PROD_URL}/`), PRODUCTION_SUPABASE_PROJECT_REF);
  assert.equal(supabaseProjectRef(PROD_URL.toUpperCase()), PRODUCTION_SUPABASE_PROJECT_REF);
  assert.equal(supabaseProjectRef("http://127.0.0.1:54321"), null);
  assert.equal(supabaseProjectRef("not a url"), null);
  assert.equal(supabaseProjectRef(undefined), null);
});

test("local development against production is refused", () => {
  const reason = productionDatabaseRefusal({ NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: PROD_URL });
  assert.ok(reason);
  assert.match(reason, /PRODUCTION Supabase project/);
  assert.match(reason, new RegExp(ALLOW_PRODUCTION_DATABASE_FLAG));
});

test("an explicit opt-in allows it", () => {
  assert.equal(
    productionDatabaseRefusal({ NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: PROD_URL, [ALLOW_PRODUCTION_DATABASE_FLAG]: "true" }),
    null,
  );
  // Anything but exactly "true" is not an opt-in.
  assert.ok(productionDatabaseRefusal({ NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: PROD_URL, [ALLOW_PRODUCTION_DATABASE_FLAG]: "1" }));
});

test("deployments and production builds are never refused", () => {
  for (const env of [
    { VERCEL: "1", NEXT_PUBLIC_SUPABASE_URL: PROD_URL },
    { RENDER: "true", NEXT_PUBLIC_SUPABASE_URL: PROD_URL },
    { RENDER_SERVICE_ID: "srv-x", NEXT_PUBLIC_SUPABASE_URL: PROD_URL },
    { NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: PROD_URL },
  ]) {
    assert.equal(productionDatabaseRefusal(env), null, JSON.stringify(env));
  }
});

test("other projects, a local stack and no Supabase at all are fine", () => {
  assert.equal(productionDatabaseRefusal({ NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: DEV_URL }), null);
  assert.equal(productionDatabaseRefusal({ NODE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }), null);
  assert.equal(productionDatabaseRefusal({ NODE_ENV: "development" }), null);
});

test("next.config.ts applies the guard before anything else runs", () => {
  const config = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /const databaseRefusal = productionDatabaseRefusal\(process\.env\);\s+if \(databaseRefusal\) throw new Error\(databaseRefusal\);/);
});
