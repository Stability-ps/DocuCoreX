// Uploads are checked by content, not just by name and declared type.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const { checkFileSignature, readResponseHead, SIGNATURE_HEAD_BYTES } = await import("../../lib/file-signature.ts");

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? Array.from(part, (c) => c.charCodeAt(0)) : part)));

const PDF = bytes("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj");
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "\x00\x00\x00\x0dIHDR");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "\x00\x10JFIF");
const GIF = bytes("GIF89a\x01\x00\x01\x00");
const BMP = bytes("BM\x36\x00\x00\x00");
const TIFF_LE = bytes([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
const TIFF_BE = bytes([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08]);
const HEIC = bytes([0x00, 0x00, 0x00, 0x18], "ftypheic\x00\x00\x00\x00mif1heic");
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
const RTF = bytes("{\\rtf1\\ansi\\deff0 Hello}");
const TEXT = bytes("Date,Description,Amount\n2026-01-02,Deposit,100.00\n");
const UTF16 = bytes([0xff, 0xfe, 0x44, 0x00, 0x61, 0x00]);
const EXE = bytes("MZ\x90\x00\x03\x00\x00\x00");
const ELF = bytes([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
const HTML = bytes("<!doctype html><script>alert(1)</script>");

const ok = (name: string, head: Uint8Array) => assert.deepEqual(checkFileSignature(name, head), { ok: true }, name);
const refused = (name: string, head: Uint8Array, pattern: RegExp) => {
  const result = checkFileSignature(name, head);
  assert.equal(result.ok, false, `${name} should be refused`);
  if (!result.ok) assert.match(result.reason, pattern);
};

test("every supported type is accepted with its real signature", () => {
  ok("statement.pdf", PDF);
  ok("scan.png", PNG);
  ok("photo.jpg", JPEG);
  ok("photo.JPEG", JPEG);
  ok("anim.gif", GIF);
  ok("old.bmp", BMP);
  ok("fax.tif", TIFF_LE);
  ok("fax.tiff", TIFF_BE);
  ok("phone.heic", HEIC);
  for (const name of ["bundle.zip", "letter.docx", "ledger.xlsx", "deck.pptx"]) ok(name, ZIP);
  for (const name of ["letter.doc", "ledger.xls", "deck.ppt"]) ok(name, OLE);
  ok("memo.rtf", RTF);
  ok("notes.txt", TEXT);
  ok("export.csv", TEXT);
  ok("export.csv", UTF16);
});

test("a PDF header after leading junk is accepted, as PDF readers do", () => {
  ok("scanner-output.pdf", bytes("\r\n\r\n", "%PDF-1.4\n"));
  const late = new Uint8Array(1100);
  late.set(bytes("%PDF-1.4"), 1050);
  refused("too-late.pdf", late, /does not look like a PDF/);
});

test("renamed executables and web pages are refused", () => {
  refused("invoice.pdf", EXE, /does not look like a PDF/);
  refused("invoice.pdf", HTML, /does not look like a PDF/);
  refused("scan.png", ELF, /does not look like a PNG image/);
  refused("ledger.xlsx", EXE, /does not look like an Excel workbook/);
  refused("letter.doc", ZIP, /does not look like a Word document/);
  refused("letter.docx", OLE, /does not look like a Word document/);
});

test("binary content in a text upload is refused", () => {
  refused("notes.txt", EXE, /does not look like a text file/);
  refused("export.csv", PNG, /does not look like a CSV file/);
});

test("an empty archive, an empty file and an unknown extension are refused", () => {
  refused("empty.zip", bytes([0x50, 0x4b, 0x05, 0x06]), /does not look like a ZIP archive/);
  refused("statement.pdf", new Uint8Array(0), /is empty/);
  refused("page.html", HTML, /not a supported file type/);
  refused("noextension", PDF, /not a supported file type/);
});

test("every extension the upload allow-list accepts has a signature rule", () => {
  // validateUploadFiles decides which extensions exist. A new one without a rule
  // here would be refused at upload, so the two lists must move together.
  const source = read("lib/server-documents.ts");
  const list = source.match(/const allowedExtensions = \/\\\.\((.+?)\)\$\/i;/)?.[1];
  assert.ok(list, "could not find allowedExtensions");
  const expanded = list.split("|").flatMap((entry) => {
    const optional = entry.match(/^(.*)(.)\?(.*)$/);
    return optional ? [optional[1] + optional[3], optional[1] + optional[2] + optional[3]] : [entry];
  });
  for (const extension of expanded) {
    const result = checkFileSignature(`file.${extension}`, bytes("x"));
    assert.ok(result.ok || !/not a supported file type/.test(result.reason), `.${extension} has no signature rule`);
  }
});

test("readResponseHead reads only the head, even when the range is ignored", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(4096).fill(0x41);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 1000) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const head = await readResponseHead(new Response(body));
  assert.equal(head.length, SIGNATURE_HEAD_BYTES);
  assert.ok(pulled < 10, `read ${pulled} chunks; it should stop after the head`);
});

test("readResponseHead returns a short file whole", async () => {
  const head = await readResponseHead(new Response(PDF));
  assert.deepEqual(head, PDF);
});

test("both upload paths check content before a file is kept", () => {
  const route = read("app/api/uploads/route.ts");

  // Multipart: the check precedes the storage write.
  const check = route.indexOf("checkFileSignature(file.name, head)");
  const write = route.indexOf('.storage.from("documents").upload(');
  assert.ok(check > 0 && write > 0 && check < write, "multipart bytes are checked before they reach storage");

  // Signed-URL registration: the stored object's head is read and checked, and
  // a mismatch (or an unreadable object) removes it before anything is registered.
  const registration = route.slice(route.indexOf("const verified = []"));
  const stored = registration.indexOf("await readStoredHead(context.supabase, file.storagePath)");
  const remove = registration.indexOf("remove([file.storagePath])", stored);
  const register = registration.indexOf("registerUploads(files)");
  assert.ok(stored > 0 && remove > stored && register > remove, "stored bytes are checked, and refused files removed, before registration");
  assert.match(route, /Range: `bytes=0-\$\{SIGNATURE_HEAD_BYTES - 1\}`/, "only the head is requested");
});
