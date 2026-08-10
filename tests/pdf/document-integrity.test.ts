import assert from "node:assert/strict";
import test from "node:test";

import { inspectDocumentIntegrity } from "../../lib/pdf/documentIntegrity.ts";

function pdf(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF\n`);
}

test("there is no score, ever", () => {
  // The instruction: no competitor-style "89.5% authentic". A percentage would
  // combine incommensurable observations with invented weights, and would be
  // believed as a measurement.
  const result = inspectDocumentIntegrity(pdf("/Producer (Bank)"));
  assert.equal("score" in result, false);
  assert.equal("authenticity" in result, false);
  assert.equal("percent" in result, false);
  assert.doesNotMatch(result.assessment, /%/);
});

test("a clean single-save document raises nothing", () => {
  const result = inspectDocumentIntegrity(pdf("/Producer (Standard Bank) /CreationDate (D:20250801)"));
  assert.equal(result.notableCount, 0);
  assert.match(result.assessment, /No structural integrity indicators/);
  // And it does not overclaim in the other direction either.
  assert.match(result.assessment, /not a statement about the document's content/);
});

test("incremental saves are counted and explained", () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nx\n%%EOF\ny\n%%EOF\nz\n%%EOF\n");
  const result = inspectDocumentIntegrity(bytes);
  const updates = result.observations.find((o) => o.id === "incremental_updates")!;
  assert.equal(updates.finding, "2", "three EOFs means two later saves");
  assert.equal(updates.notable, true);
  assert.ok(updates.benignExplanation, "a notable observation must offer its innocent cause");
  assert.match(updates.benignExplanation!, /does not indicate the content was changed/);
});

test("every notable observation carries a benign explanation", () => {
  // The rule that keeps this from reading as an accusation.
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\n/CreationDate (D:20250101) /ModDate (D:20250820)\n%%EOF\nmore\n%%EOF\n",
  );
  const result = inspectDocumentIntegrity(bytes);
  assert.ok(result.notableCount >= 2);
  for (const observation of result.observations.filter((o) => o.notable)) {
    assert.ok(observation.benignExplanation, `${observation.id} must explain its innocent cause`);
  }
});

test("a differing modification date is noted, a matching one is not", () => {
  const changed = inspectDocumentIntegrity(pdf("/CreationDate (D:20250101) /ModDate (D:20250820)"));
  assert.equal(changed.observations.find((o) => o.id === "metadata_dates")!.notable, true);

  const same = inspectDocumentIntegrity(pdf("/CreationDate (D:20250101) /ModDate (D:20250101)"));
  assert.equal(same.observations.find((o) => o.id === "metadata_dates")!.notable, false);

  const absent = inspectDocumentIntegrity(pdf("/CreationDate (D:20250101)"));
  assert.equal(absent.observations.find((o) => o.id === "metadata_dates")!.finding, "Not recorded");
  assert.equal(absent.observations.find((o) => o.id === "metadata_dates")!.notable, false, "absence proves nothing");
});

test("an unsigned document is not suspicious", () => {
  // Almost no bank statement is digitally signed; flagging the absence would
  // make every genuine statement look questionable.
  const result = inspectDocumentIntegrity(pdf("/Producer (Bank)"));
  const signature = result.observations.find((o) => o.id === "digital_signature")!;
  assert.equal(signature.finding, "Not detected");
  assert.equal(signature.notable, false);
});

test("a signature is detected when present", () => {
  const result = inspectDocumentIntegrity(pdf("/ByteRange [0 100 200 300]"));
  assert.equal(result.observations.find((o) => o.id === "digital_signature")!.finding, "Present");
});

test("producing software is reported but never judged", () => {
  // No basis exists for calling one producer more trustworthy than another; a
  // list of "suspicious" tools would be a guess dressed as a check.
  const result = inspectDocumentIntegrity(pdf("/Creator (Photoshop) /Producer (Ghostscript)"));
  const producer = result.observations.find((o) => o.id === "producer")!;
  assert.match(producer.finding, /Photoshop/);
  assert.equal(producer.notable, false, "even an editing tool is not itself an indicator");
});

test("encryption is context, not an indicator", () => {
  // Banks routinely password-protect statements.
  const result = inspectDocumentIntegrity(pdf("/Encrypt 12 0 R"));
  const encryption = result.observations.find((o) => o.id === "encryption")!;
  assert.equal(encryption.finding, "Declared");
  assert.equal(encryption.notable, false);
});

test("the assessment recommends looking, never concludes", () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\na\n%%EOF\nb\n%%EOF\n");
  const result = inspectDocumentIntegrity(bytes);
  assert.match(result.assessment, /manual look/);
  assert.match(result.assessment, /not findings of fraud/);
});

test("empty or non-PDF input does not throw", () => {
  assert.doesNotThrow(() => inspectDocumentIntegrity(new Uint8Array()));
  assert.doesNotThrow(() => inspectDocumentIntegrity(new TextEncoder().encode("not a pdf at all")));
  const result = inspectDocumentIntegrity(new Uint8Array());
  assert.equal(result.notableCount, 0);
});
