// Stored files must actually be removed when their document or run is deleted
// (release audit, 2026-10-08: a permanent delete of 33 documents left every file).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("a storage DELETE policy scoped to the caller's workspace exists (049)", () => {
  const migration = read("supabase/migrations/049_storage_delete_policy.sql");
  assert.match(migration, /create policy "Users can delete workspace document objects" on storage\.objects\s+for delete using/);
  assert.match(migration, /split_part\(name, '\/', 1\) in \(\s+select workspace_id::text from public\.profiles where id = auth\.uid\(\)/);
  assert.match(read("supabase/schema.sql"), /Users can delete workspace document objects/);
  assert.match(read("supabase/bucket_setup.sql"), /Users can delete workspace document objects/);
});

test("permanent document delete reports a storage removal that did not happen", () => {
  const source = read("lib/server-documents.ts");
  assert.ok(source.includes("docucorex.documents.storage_remove_incomplete"));
  assert.ok(!source.includes('await context.supabase.storage.from("documents").remove(Array.from(new Set(storagePaths)));'), "the result is no longer discarded");
});

test("deleting a statement run removes its generated workbook", () => {
  const source = read("lib/accounting/server.ts");
  const fn = source.slice(source.indexOf("export async function deleteAccountingRuns"));
  assert.ok(fn.includes("run.workbook_storage_path"));
  assert.ok(fn.includes(".remove(workbookPaths)"));
});
