// The contract for the *_PATH overrides read by resolveExecutable() in
// lib/document-conversion-engine.ts.
//
// These variables used to be *prepended* to the default candidates, so a path
// that did not exist was skipped and resolution continued to `which`. The
// variable could therefore express "prefer this location" but never "this tool
// is absent" — and tests/e2e/conversion-engine.spec.ts:189, which points them at
// missing paths to prove OCR fails rather than faking success, only passed on
// machines that happened to lack ocrmypdf. It asserted a guarantee it did not
// test.
//
// An explicit path is now authoritative. These tests pin that in the gating
// suite rather than the non-blocking e2e job, because the e2e job's own history
// is what let the defect survive.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("../pdf/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { verifyOcrRuntime, verifyConversionRuntime } = await import("@/lib/document-conversion-engine.ts");

function withEnv(values: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** A real, executable file that answers any argv with success. */
function makeStubBinary(dir: string, name: string) {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

test("an explicit path that exists is used", () => {
  const dir = mkdtempSync(join(tmpdir(), "docucorex-exec-"));
  try {
    const stub = makeStubBinary(dir, "ocrmypdf");
    const restore = withEnv({ OCRMYPDF_PATH: stub });
    try {
      const { dependencies } = verifyOcrRuntime();
      assert.equal(dependencies.ocrmypdf.ok, true, "the stub should satisfy the check");
      assert.equal(dependencies.ocrmypdf.path, stub, "the configured path must be the one used");
    } finally {
      restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit path that does not exist means UNAVAILABLE, never a PATH fallback", () => {
  // THE regression, and it has to bite on every machine. Asserting this with
  // only a missing override would pass vacuously anywhere ocrmypdf is absent
  // from PATH — which is how the original defect hid. So a working ocrmypdf is
  // planted on PATH first: under the old prepend-and-continue behaviour the
  // missing override was skipped, `which` found this stub, and the check
  // reported ok: true.
  const dir = mkdtempSync(join(tmpdir(), "docucorex-exec-"));
  try {
    makeStubBinary(dir, "ocrmypdf");
    const onPath = withEnv({ PATH: `${dir}:${process.env.PATH ?? ""}`, OCRMYPDF_PATH: undefined });
    // Control: prove the stub really is discoverable, or the test below proves
    // nothing about the override.
    const discoverable = verifyOcrRuntime().dependencies.ocrmypdf;
    onPath();
    assert.equal(discoverable.ok, true, "precondition: the planted ocrmypdf must be findable on PATH");

    const restore = withEnv({
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      OCRMYPDF_PATH: "/definitely/missing/ocrmypdf",
    });
    try {
      const { ok, dependencies, message } = verifyOcrRuntime();
      assert.equal(dependencies.ocrmypdf.ok, false, "a missing configured path must not fall back to PATH");
      assert.equal(dependencies.ocrmypdf.path, undefined, "nothing may be resolved when the configured path is absent");
      assert.equal(ok, false);
      assert.match(message ?? "", /ocrmypdf/);
    } finally {
      restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the override is per-tool: configuring one off does not disturb the others", () => {
  const restore = withEnv({ PDFTOPPM_PATH: "/definitely/missing/pdftoppm" });
  try {
    const { dependencies } = verifyConversionRuntime();
    assert.equal(dependencies.pdftoppm.ok, false);
    // The rest still resolve however this machine resolves them; the point is
    // only that the forced-off tool did not take them with it.
    for (const name of ["libreoffice", "pdftotext", "pdfinfo"] as const) {
      assert.equal(typeof dependencies[name].ok, "boolean");
    }
  } finally {
    restore();
  }
});

test("an unset override still resolves through PATH", () => {
  // `sh` stands in for a default candidate: always present, always executable.
  // Asserting the unset branch is unchanged is the other half of the contract —
  // the fix must not turn every unconfigured tool into "unavailable".
  const dir = mkdtempSync(join(tmpdir(), "docucorex-exec-"));
  try {
    const stub = makeStubBinary(dir, "pdftotext");
    const configured = withEnv({ PDFTOTEXT_PATH: stub });
    const withOverride = verifyConversionRuntime().dependencies.pdftotext;
    configured();

    const cleared = withEnv({ PDFTOTEXT_PATH: undefined });
    const withoutOverride = verifyConversionRuntime().dependencies.pdftotext;
    cleared();

    assert.equal(withOverride.ok, true);
    assert.equal(withOverride.path, stub);
    // Unset resolution is independent of the override: it either finds the real
    // pdftotext on this machine or reports it missing, but never the stub.
    assert.notEqual(withoutOverride.path, stub);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
