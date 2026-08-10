import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MAX_TAG_LENGTH, dedupeTags, isValidTag, normalizeTag, sameTag, sortTags, tagRejection } from "../../lib/accounting/tags.ts";

test("normalisation tidies whitespace but never casing", () => {
  // "Project Alpha" is how the user wrote it; echoing back "project alpha"
  // reads as a bug, so uniqueness is handled case-insensitively instead.
  assert.equal(normalizeTag("  Project   Alpha  "), "Project Alpha");
  assert.equal(normalizeTag("Vehicle\t2"), "Vehicle 2");
  assert.equal(normalizeTag("SARS"), "SARS");
});

test("empty and whitespace-only tags are rejected", () => {
  for (const raw of ["", "   ", "\t", "\n  \n"]) {
    assert.equal(tagRejection(raw), "empty", JSON.stringify(raw));
    assert.equal(isValidTag(raw), false);
  }
});

test("length is measured after normalisation", () => {
  // A value that only exceeds the limit because of runs of spaces is untidy,
  // not too long — rejecting it would be misleading.
  const spaced = "a" + " ".repeat(MAX_TAG_LENGTH + 10) + "b";
  assert.ok(spaced.length > MAX_TAG_LENGTH);
  assert.equal(tagRejection(spaced), null);

  assert.equal(tagRejection("x".repeat(MAX_TAG_LENGTH)), null);
  assert.equal(tagRejection("x".repeat(MAX_TAG_LENGTH + 1)), "too_long");
});

test("tag identity is case-insensitive, matching the database index", () => {
  assert.ok(sameTag("Project Alpha", "project alpha"));
  assert.ok(sameTag("  VEHICLE 2 ", "Vehicle 2"));
  assert.ok(!sameTag("Property 1", "Property 2"));
});

test("dedupe keeps the first spelling and drops case duplicates", () => {
  // The vocabulary must not offer a tag twice and invite the user to create a
  // duplicate the unique index would then reject.
  assert.deepEqual(dedupeTags(["Vehicle 2", "vehicle 2", "VEHICLE 2"]), ["Vehicle 2"]);
  assert.deepEqual(dedupeTags(["  Director  ", "Director"]), ["Director"]);
  assert.deepEqual(dedupeTags(["A", "", "   ", "B"]), ["A", "B"]);
});

test("sorting is stable and case-insensitive", () => {
  assert.deepEqual(sortTags(["vehicle", "Director", "sars"]), ["Director", "sars", "vehicle"]);
});

test("the migration keeps tags off accounting_transactions", () => {
  // The load-bearing reason: replace_accounting_transactions_owned deletes and
  // reinserts every row of accounting_transactions on each reprocess, from a
  // worker payload that knows nothing about tags. A tag COLUMN would be
  // destroyed by the next reprocess; a referencing table survives.
  const migration = readFileSync("supabase/migrations/031_accounting_transaction_tags.sql", "utf8");
  assert.ok(
    /create table if not exists public\.accounting_transaction_tags/.test(migration),
    "tags must live in their own table",
  );
  assert.ok(
    !/alter table[\s\S]*accounting_transactions[\s\S]*add column/i.test(migration),
    "tags must not be added as a column on accounting_transactions",
  );
});

test("the migration is workspace-scoped, RLS-enabled and indexed", () => {
  const migration = readFileSync("supabase/migrations/031_accounting_transaction_tags.sql", "utf8");
  assert.ok(/workspace_id uuid not null references public\.workspaces/.test(migration), "workspace scoping");
  assert.ok(/enable row level security/.test(migration), "RLS enabled");
  assert.ok(/create policy .* on public\.accounting_transaction_tags/.test(migration), "RLS policy present");
  assert.ok(/on delete cascade/.test(migration), "tags are removed with their transaction");
  // Case-insensitive uniqueness, so "project alpha" cannot become a second tag.
  assert.ok(
    /create unique index[\s\S]*lower\(trim\(tag\)\)/.test(migration),
    "unique index must be case-insensitive",
  );
});
