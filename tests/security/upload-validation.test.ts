import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { validateUploadFiles } = await import("@/lib/server-documents.ts");

// POST /api/uploads wrote each file to storage and only then validated it, so a
// rejected upload was refused with 400 but its bytes stayed in the bucket with
// no document row (release audit, 2026-10-07: probe.html, probe.svg and a
// MIME-spoofed probe.pdf all persisted). The bucket itself has no type or size
// limit, so this validation is the only control.

const ok = (name: string, type: string, size = 1024) => () => validateUploadFiles([{ name, type, size }]);

test("supported documents pass", () => {
  assert.doesNotThrow(ok("statement.pdf", "application/pdf"));
  assert.doesNotThrow(ok("ledger.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  assert.doesNotThrow(ok("scan.png", "image/png"));
});

test("active content is refused by extension", () => {
  assert.throws(ok("probe.html", "text/html"), /not a supported file type/);
  assert.throws(ok("probe.svg", "image/svg+xml"), /not a supported file type/);
});

test("a supported extension with an active MIME type is refused", () => {
  assert.throws(ok("probe-spoof.pdf", "text/html"), /unsupported MIME type/);
});

test("empty and oversized files are refused", () => {
  assert.throws(ok("empty.pdf", "application/pdf", 0), /is empty/);
  assert.throws(ok("huge.pdf", "application/pdf", 201 * 1024 * 1024), /200 MB/);
});

test("the direct upload validates before writing to storage", () => {
  const route = readFileSync("app/api/uploads/route.ts", "utf8");
  const validate = route.indexOf("validateUploadFiles(");
  const write = route.indexOf('.storage.from("documents").upload(');
  assert.ok(validate > 0 && write > 0, "both the validation and the storage write must be present");
  assert.ok(validate < write, "validation must precede the storage write");
});

test("a signed upload URL is only issued for a supported file", () => {
  const route = readFileSync("app/api/uploads/signed-url/route.ts", "utf8");
  const validate = route.indexOf("validateUploadFiles(");
  const sign = route.indexOf("createSignedUploadUrl(");
  assert.ok(validate > 0 && sign > 0 && validate < sign, "validate before signing");
});
