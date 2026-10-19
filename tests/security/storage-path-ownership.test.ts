// Privileged storage reads only touch the job's own workspace folder.
//
// The service-role client bypasses storage RLS, and the paths it reads come from
// rows users can edit. A user who pointed their document at another workspace's
// file had OCR, conversion or the accounting worker read it for them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const { isWorkspaceStoragePath, assertWorkspaceStoragePath, ForeignStoragePathError } = await import("../../lib/storage-paths.ts");

const WS = "11111111-0000-0000-0000-000000000001";
const OTHER = "11111111-0000-0000-0000-0000000000f2";

test("paths inside the workspace folder are allowed", () => {
  assert.equal(isWorkspaceStoragePath(`${WS}/documents/a.pdf`, WS), true);
  assert.equal(isWorkspaceStoragePath(`${WS}/accounting/run/workbook.xlsx`, WS), true);
});

test("anything else is refused", () => {
  for (const path of [
    `${OTHER}/documents/a.pdf`,
    `${WS}`,
    `${WS}/`,
    `${WS}//a.pdf`,
    `${WS}/./a.pdf`,
    `${WS}/../${OTHER}/documents/a.pdf`,
    `/${WS}/documents/a.pdf`,
    `${WS}\\documents\\a.pdf`,
    `${WS}/documents/a\0.pdf`,
    `${WS}x/documents/a.pdf`,
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isWorkspaceStoragePath(path, WS), false, JSON.stringify(path));
  }
  assert.equal(isWorkspaceStoragePath(`${WS}/documents/a.pdf`, ""), false);
  assert.equal(isWorkspaceStoragePath(`${WS}/documents/a.pdf`, null), false);
});

test("the assertion throws a typed error and never logs the path", () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(JSON.stringify(args));
  try {
    assert.throws(() => assertWorkspaceStoragePath(`${OTHER}/documents/secret-name.pdf`, WS, { reader: "test" }), ForeignStoragePathError);
  } finally {
    console.error = original;
  }
  assert.ok(lines.length === 1);
  assert.ok(!lines[0].includes("secret-name"), "the refused path must not be logged");
});

test("the OCR/extraction loader checks ownership before the privileged download", () => {
  const source = read("lib/ocr/loadDocumentBytes.ts");
  const check = source.indexOf("assertWorkspaceStoragePath(storagePath, workspaceId");
  const download = source.indexOf('.storage.from("documents").download(storagePath)');
  assert.ok(check > 0 && download > check);
  assert.match(source, /export async function loadDocumentBytes\(storagePath: string, workspaceId: string\)/, "the workspace is required");
  assert.match(read("lib/ocr/extractDocument.ts"), /loadDocumentBytes\(document\.storagePath, document\.workspaceId\)/);
});

test("the worker's conversion download checks ownership first", () => {
  const route = read("app/api/jobs/process/route.ts");
  const check = route.indexOf("assertWorkspaceStoragePath(document.storagePath, context.workspaceId");
  const download = route.indexOf('.storage.from("documents").download(document.storagePath)');
  assert.ok(check > 0 && download > check);
});

test("no other module downloads with the service role", () => {
  // The privileged readers are the three checked above (plus the Python worker,
  // covered by its own regression suite). A new one must add the same check.
  const serviceRoleUsers = ["lib/ocr/loadDocumentBytes.ts", "app/api/jobs/process/route.ts", "lib/workspace-bootstrap.ts", "app/dev/diagnostics/page.tsx"];
  for (const file of serviceRoleUsers) assert.match(read(file), /createSupabaseServiceRoleClient\(\)/, `${file} still uses the service role`);
  assert.doesNotMatch(read("lib/workspace-bootstrap.ts"), /storage/, "bootstrap must not touch storage");
});

test("the database refuses foreign paths too (migration 053)", () => {
  const migration = read("supabase/migrations/053_storage_paths_stay_in_workspace.sql");
  for (const [table, column] of [
    ["documents", "storage_path"],
    ["uploads", "storage_path"],
    ["document_versions", "storage_path"],
    ["conversions", "download_path"],
    ["accounting_statement_runs", "source_storage_path"],
    ["accounting_statement_runs", "workbook_storage_path"],
  ]) {
    assert.match(migration, new RegExp(`on public\\.${table}\\s+for each row execute function public\\.enforce_storage_path_in_workspace\\('${column}'\\)`), `${table}.${column}`);
  }
});
