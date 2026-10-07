import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

// Release audit, 2026-10-07: a 6 MB PDF died at Vercel with a raw 413
// (FUNCTION_PAYLOAD_TOO_LARGE) — multipart uploads through a function can never
// reach the advertised 200 MB. Large files now go straight to storage via a
// signed URL and are registered afterwards; registration used to trust the
// client's path, size and type outright.
const { isOwnDocumentsPath, DIRECT_UPLOAD_THRESHOLD_BYTES } = await import("@/lib/direct-upload.ts");

const ws = "1cdfbe11-832c-45ff-bde3-35598efb5b4e";

test("registration accepts only an object in the caller's own documents folder", () => {
  assert.equal(isOwnDocumentsPath(`${ws}/documents/abc-scan.pdf`, ws), true);
  assert.equal(isOwnDocumentsPath(`49ad77ef-432f-4199-b03a-4c0806872f06/documents/abc.pdf`, ws), false, "another workspace");
  assert.equal(isOwnDocumentsPath(`${ws}x/documents/abc.pdf`, ws), false, "look-alike workspace prefix");
  assert.equal(isOwnDocumentsPath(`${ws}/accounting/statements/abc.pdf`, ws), false, "another folder");
  assert.equal(isOwnDocumentsPath(`${ws}/documents/nested/abc.pdf`, ws), false, "sub-folder");
  assert.equal(isOwnDocumentsPath(`${ws}/documents/..`, ws), false, "traversal");
  assert.equal(isOwnDocumentsPath(`${ws}/documents/`, ws), false, "no object name");
  assert.equal(isOwnDocumentsPath(undefined, ws), false);
});

test("the threshold keeps every direct upload under Vercel's body limit", () => {
  assert.ok(DIRECT_UPLOAD_THRESHOLD_BYTES <= 4.5 * 1024 * 1024);
});

test("registration checks ownership and the STORED object before registering", () => {
  const route = readFileSync("app/api/uploads/route.ts", "utf8");
  const json = route.slice(route.indexOf("let files = body.files"));
  const own = json.indexOf("isOwnDocumentsPath(");
  const list = json.indexOf(".list(folder");
  const validate = json.indexOf("validateUploadFiles([actual])");
  const registerCall = json.indexOf("registerUploads(files)");
  assert.ok(own > 0 && list > own && validate > list && registerCall > validate, "own path → read stored object → validate → register");
  assert.match(json, /metadata\.size/, "the size validated is the stored object's");
});

test("large documents take the direct-to-storage path; statements say why they cannot", () => {
  const panel = readFileSync("components/documents/document-upload-panel.tsx", "utf8");
  assert.match(panel, /file\.size <= DIRECT_UPLOAD_THRESHOLD_BYTES/);
  assert.match(panel, /\/api\/uploads\/signed-url/);
  const accounting = readFileSync("components/accounting/accounting-intelligence.tsx", "utf8");
  assert.match(accounting, /file\.size > DIRECT_UPLOAD_THRESHOLD_BYTES/);
});
