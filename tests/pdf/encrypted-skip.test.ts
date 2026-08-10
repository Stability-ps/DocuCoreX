// An encrypted PDF cannot be OCR'd, and the pipeline used to discover that by
// trying: four ocrmypdf flag combinations, ~10s, on every run of an encrypted
// statement. Production logs showed exactly that on a 37-page Standard Bank
// statement — "EncryptedPdfError: Input PDF is encrypted", four attempts, every
// time. Reading the trailer first answers it in milliseconds.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { declaresEncryption } = await import("@/lib/pdf/ocrEngine.ts");

const bytes = (s: string) => new TextEncoder().encode(s);

test("an /Encrypt trailer reference is detected", () => {
  const pdf = bytes("%PDF-1.7\n…body…\ntrailer\n<< /Size 42 /Root 1 0 R /Encrypt 12 0 R >>\nstartxref\n0\n%%EOF");
  assert.equal(declaresEncryption(pdf), true);
});

test("an ordinary PDF is not flagged", () => {
  const pdf = bytes("%PDF-1.7\n…body…\ntrailer\n<< /Size 42 /Root 1 0 R >>\nstartxref\n0\n%%EOF");
  assert.equal(declaresEncryption(pdf), false);
});

test("the bare word /Encrypt does not trigger it", () => {
  // "/Encrypt" can appear in a content stream or a font name. Only the indirect
  // reference is the trailer's encryption dictionary — a false positive would
  // skip OCR for a file that might have worked.
  const pdf = bytes("%PDF-1.7\n(/Encrypt is discussed in this document)\ntrailer\n<< /Root 1 0 R >>\n%%EOF");
  assert.equal(declaresEncryption(pdf), false);
});

test("detection works on a large file without decoding all of it", () => {
  // The trailer lives at the end; a 350KB statement must not be decoded whole.
  const filler = "x".repeat(400_000);
  const encrypted = bytes(`%PDF-1.7\n${filler}\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF`);
  const plain = bytes(`%PDF-1.7\n${filler}\ntrailer\n<< /Root 1 0 R >>\n%%EOF`);
  assert.equal(declaresEncryption(encrypted), true);
  assert.equal(declaresEncryption(plain), false);
});

test("an /Encrypt reference far from the end is not scanned", () => {
  // Documented limitation, asserted so it is a known trade rather than a
  // surprise: only the trailing region is read. A linearised PDF with its
  // trailer at the front would be missed, and would simply fall back to the
  // previous behaviour — attempt, fail, report encrypted.
  const encrypted = bytes(`%PDF-1.7\ntrailer\n<< /Encrypt 9 0 R >>\n${"x".repeat(400_000)}\n%%EOF`);
  assert.equal(declaresEncryption(encrypted), false);
});
