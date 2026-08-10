import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const { destroyPdfSession } = await import("@/lib/pdf/pdfSession.ts");

// Production: opening a statement from Accounting Intelligence rendered the PDF
// and then replaced the page with the error boundary —
//
//   l.destroy is not a function
//
// `l` was the PDFDocumentProxy. In pdfjs-dist 6.x the proxy has cleanup() but
// NOT destroy(); teardown belongs to the loading task. The viewer held the
// proxy and called destroy() on it, so every unmount threw — after a successful
// render, because the reference is only set once the load resolves.

/** The shapes pdfjs-dist 6.x actually returns. */
function loadingTask() {
  const state = { destroyed: 0 };
  return { state, task: { promise: Promise.resolve({}), destroy: async () => { state.destroyed += 1; } } };
}

function documentProxy() {
  // Deliberately no destroy(), matching PDFDocumentProxy in 6.x.
  return { numPages: 3, getPage: async () => ({}), cleanup: async () => {} };
}

test("the installed pdf.js puts destroy() on the loading task, not the document", () => {
  // The assertion that would have caught this at the version bump. If a future
  // pdfjs-dist moves destroy() back onto the proxy, this fails loudly rather
  // than letting the viewer quietly hold the wrong object again.
  const bundle = read("node_modules/pdfjs-dist/build/pdf.mjs");

  const classBody = (name: string) => {
    const start = bundle.indexOf(`class ${name}`);
    assert.ok(start > -1, `${name} should exist in the bundle`);
    let depth = 0;
    let index = bundle.indexOf("{", start);
    const from = index;
    for (;;) {
      if (bundle[index] === "{") depth += 1;
      else if (bundle[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      index += 1;
    }
    return bundle.slice(from, index);
  };

  assert.match(classBody("PDFDocumentLoadingTask"), /\bdestroy\s*\(/, "the loading task owns destroy()");
  assert.ok(!/\n\s{2}destroy\s*\(/.test(classBody("PDFDocumentProxy")), "the document proxy has no destroy()");
});

test("destroying a session destroys the loading task", () => {
  const { state, task } = loadingTask();
  assert.equal(destroyPdfSession(task), true);
  assert.equal(state.destroyed, 1);
});

test("cleanup is idempotent — React runs it more than once", () => {
  // Effect cleanup runs on unmount, on every dependency change, and twice on
  // mount under StrictMode.
  const { state, task } = loadingTask();
  destroyPdfSession(task);
  destroyPdfSession(task);
  destroyPdfSession(null);
  destroyPdfSession(undefined);
  assert.equal(state.destroyed, 2, "each call with a task destroys; null is a no-op");
});

test("a session that never loaded tears down without throwing", () => {
  assert.equal(destroyPdfSession(null), false, "nothing to destroy is not an error");
});

test("handing it the document proxy is rejected, not swallowed", () => {
  // The original defect, as a value. Silently ignoring the wrong object would
  // hide the next pdf.js API change exactly as this one was hidden.
  assert.throws(
    () => destroyPdfSession(documentProxy() as never),
    /loading task with destroy/,
    "the proxy has no destroy() and must not be accepted",
  );
});

test("a failing destroy does not propagate — a dead worker is already torn down", () => {
  const task = { promise: Promise.resolve({}), destroy: async () => { throw new Error("worker already terminated"); } };
  assert.equal(destroyPdfSession(task), true, "reports that teardown was attempted");
});

test("the viewer holds the loading task and destroys that", () => {
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /loadingTaskRef = useRef<PdfLoadingTask \| null>\(null\)/, "keeps the task");
  assert.match(viewer, /destroyPdfSession\(loadingTaskRef\.current\)/, "destroys the task on cleanup");
  assert.ok(!/pdfRef\.current\?\.destroy\(\)/.test(viewer), "must not call destroy() on the document proxy");
  assert.ok(!/void doc\.destroy\(\)/.test(viewer), "must not call destroy() on the resolved document");
  assert.ok(
    !/type PdfDoc = \{[^}]*destroy/.test(viewer),
    "the document type must not claim a destroy() the object does not have",
  );
});

test("zoomed pages use native two-axis scrolling without centered-overflow clipping", () => {
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /data-testid="document-viewer-scroll-container"/, "container has stable selector for geometry tests");
  assert.match(viewer, /className="flex h-max min-h-full min-w-full w-max justify-center p-3"/, "scroll surface tracks real document width");
  assert.match(viewer, /className="h-fit w-fit"/, "page remains centered inside the real surface");
  assert.doesNotMatch(viewer, /className="flex min-h-full justify-center p-3"/, "centered flex overflow makes one side unreachable");
});

test("fit and page changes reset stale scroll offsets", () => {
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /containerRef\.current\?\.scrollTo\(\{ left: 0, top: 0 \}\)/, "fit resets scroll origin");
  assert.match(viewer, /useEffect\(\(\) => \{[\s\S]*containerRef\.current\?\.scrollTo\(\{ left: 0, top: 0 \}\);\s*\}, \[page\]\);/, "page switches clamp to valid scroll coordinates");
});

test("a refresh does not unmount the statement workspace", () => {
  // loadDetail() sets loading on every poll tick, so a bare `if (loading)`
  // early return unmounted the whole tree — and the PDF viewer with it —
  // several times a minute during a reprocess.
  const workspace = read("components/accounting/statement-workspace.tsx");
  assert.match(workspace, /if \(loading && !detail\)/, "only the first load replaces the workspace");
  assert.ok(!/\n  if \(loading\) \{/.test(workspace), "a refresh must not unmount the viewer");
});

// ── Server-side extraction ───────────────────────────────────────────────────
//
// extractWithPdfjs had the same confusion as the viewer, but silently: it
// guarded with `typeof doc.destroy === "function"` before destroying, and on
// pdfjs-dist 6.x that condition is ALWAYS false. So server-side extraction
// never tore down its pdf.js session at all. It could not crash, so it leaked
// quietly on every document processed.

test("server extraction owns teardown through the loading task", () => {
  const extract = read("lib/pdf/extractWithPdfjs.ts");
  assert.match(extract, /loadingTask = pdfjs\.getDocument\(/, "the task is captured, not discarded");
  assert.match(extract, /await loadingTask\.promise/, "the document comes from the captured task");
  assert.match(extract, /destroyPdfSession\(loadingTask\)/, "and the task is destroyed");
  assert.ok(!/typeof doc\.destroy === "function"/.test(extract), "the always-false guard is gone");
  assert.ok(!/type PdfDocProxy = \{[^}]*destroy/.test(extract), "the proxy type must not claim destroy()");
});

test("server extraction tears down on the failure path too", () => {
  // A PDF that threw half way through page extraction has allocated as much as
  // one that finished, so teardown belongs in finally rather than after the
  // happy path.
  const extract = read("lib/pdf/extractWithPdfjs.ts");
  assert.match(extract, /\} finally \{[\s\S]*destroyPdfSession\(loadingTask\)/, "teardown runs in finally");
});

test("the legacy Node build has the same API shape as the browser build", () => {
  // extractWithPdfjs imports pdfjs-dist/legacy, so the browser-build assertion
  // above does not cover it.
  const bundle = read("node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const classBody = (name: string) => {
    const start = bundle.indexOf(`class ${name}`);
    assert.ok(start > -1, `${name} should exist in the legacy bundle`);
    let depth = 0;
    let index = bundle.indexOf("{", start);
    const from = index;
    for (;;) {
      if (bundle[index] === "{") depth += 1;
      else if (bundle[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      index += 1;
    }
    return bundle.slice(from, index);
  };
  assert.match(classBody("PDFDocumentLoadingTask"), /\bdestroy\s*\(/, "the legacy loading task owns destroy()");
  assert.ok(!/\n\s{2}destroy\s*\(/.test(classBody("PDFDocumentProxy")), "the legacy proxy has no destroy()");
});
