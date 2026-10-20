// A workspace that has blocked external AI processing never sends a document to
// Azure, Mistral or OpenAI (lib/privacy/external-processing.ts, migration 051).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const { getExternalProcessing, EXTERNAL_PROCESSING_DEMO } = await import("@/lib/privacy/external-processing.ts");
const { runExtractionPipeline } = await import("@/lib/pdf/runExtractionPipeline.ts");

// ---- reading the setting --------------------------------------------------

function fakeClient(result: { data: unknown; error: { code?: string; message?: string } | null } | Error) {
  const asked: Array<{ table: string; column?: string; value?: string }> = [];
  const client = {
    from(table: string) {
      const entry: { table: string; column?: string; value?: string } = { table };
      asked.push(entry);
      return {
        select() {
          return {
            eq(column: string, value: string) {
              entry.column = column;
              entry.value = value;
              return {
                maybeSingle: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
              };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as { from: (table: never) => unknown }, asked };
}

const quietly = async <T>(run: () => Promise<T>) => {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

test("the owner's choice is honoured, for the workspace asked about", async () => {
  const blocked = fakeClient({ data: { external_ai_processing: "blocked" }, error: null });
  assert.deepEqual(await getExternalProcessing(blocked.client, "ws-1"), { allowed: false, source: "setting" });
  assert.deepEqual(blocked.asked, [{ table: "workspace_privacy_settings", column: "workspace_id", value: "ws-1" }]);

  const allowed = fakeClient({ data: { external_ai_processing: "allowed" }, error: null });
  assert.deepEqual(await getExternalProcessing(allowed.client, "ws-1"), { allowed: true, source: "setting" });
});

test("no recorded choice keeps today's behaviour", async () => {
  const none = fakeClient({ data: null, error: null });
  assert.deepEqual(await getExternalProcessing(none.client, "ws-1"), { allowed: true, source: "default" });
});

test("before migration 051 exists, nobody can have chosen, so behaviour is unchanged", async () => {
  for (const code of ["PGRST205", "42P01"]) {
    const missing = fakeClient({ data: null, error: { code, message: "relation does not exist" } });
    assert.deepEqual(await getExternalProcessing(missing.client, "ws-1"), { allowed: true, source: "not_migrated" });
  }
});

test("an unreadable setting fails closed", async () => {
  const failing = fakeClient({ data: null, error: { code: "57014", message: "timeout" } });
  assert.deepEqual(await quietly(() => getExternalProcessing(failing.client, "ws-1")), { allowed: false, source: "error" });
  const thrown = fakeClient(new Error("network"));
  assert.deepEqual(await quietly(() => getExternalProcessing(thrown.client, "ws-1")), { allowed: false, source: "error" });
  const odd = fakeClient({ data: { external_ai_processing: "sometimes" }, error: null });
  assert.deepEqual(await getExternalProcessing(odd.client, "ws-1"), { allowed: false, source: "error" });
});

test("demo mode (no backend, no customer data) is allowed", () => {
  assert.deepEqual(EXTERNAL_PROCESSING_DEMO, { allowed: true, source: "demo" });
});

// ---- the pipeline really does not call out ---------------------------------

// A one-page PDF with no text: scanned as far as the pipeline is concerned, so
// the acceptance gate rejects it and the escalation ladder would call Azure and
// then Mistral if allowed.
const BLANK_PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

async function outboundHostsFor(allowExternalProviders: boolean): Promise<string[]> {
  const saved = { ...process.env };
  Object.assign(process.env, {
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://azure.test.invalid/",
    AZURE_DOCUMENT_INTELLIGENCE_KEY: "test-azure-key",
    MISTRAL_API_KEY: "test-mistral-key",
  });
  delete process.env.PDF_PLUMBER_URL;
  delete process.env.CONVERSION_WORKER_URL;
  delete process.env.CONVERSION_WORKER_MODE;

  const hosts: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    hosts.push(new URL(String(input instanceof Request ? input.url : input)).host);
    return new Response(JSON.stringify({ error: "test" }), { status: 503 });
  }) as typeof fetch;
  console.info = () => undefined;
  try {
    await runExtractionPipeline(new Uint8Array(BLANK_PDF), "scan.pdf", {
      force: true,
      expect: "document",
      allowExternalProviders,
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return hosts;
}

test("allowed: a rejected scan escalates to the external engines (proves the test can see it)", async () => {
  const hosts = await outboundHostsFor(true);
  assert.ok(
    hosts.some((h) => h === "azure.test.invalid" || h === "api.mistral.ai"),
    `expected an external call, saw ${JSON.stringify(hosts)}`,
  );
});

test("blocked: the same scan is never sent to Azure or Mistral", async () => {
  const hosts = await outboundHostsFor(false);
  assert.deepEqual(hosts.filter((h) => h === "azure.test.invalid" || h === "api.mistral.ai" || h === "api.openai.com"), []);
});

// ---- every entry point applies it ------------------------------------------

test("every place that starts processing reads the workspace's choice", () => {
  assert.match(read("app/api/jobs/process/route.ts"), /externalProcessing: context \? await getExternalProcessing\(context\.supabase, context\.workspaceId\) : EXTERNAL_PROCESSING_DEMO/);
  const jobs = read("lib/ocr/asyncJobs.ts");
  assert.equal(jobs.split("getExternalProcessing(context.supabase, context.workspaceId)").length - 1, 2, "both OCR and extraction jobs");
  assert.match(read("app/api/pdf/analyze/[documentId]/route.ts"), /allowExternalProviders: externalProcessing\.allowed/);
  const accounting = read("app/api/accounting/fnb/process/route.ts");
  assert.match(accounting, /const externalProcessing = await getExternalProcessing\(context\.supabase, context\.workspaceId\);/);
  assert.match(accounting, /allow_external_ai: externalProcessing\.allowed,/, "the accounting worker is told");
  assert.equal(accounting.split("allowExternalProviders: externalProcessing.allowed").length - 1, 3, "pre-extraction, Enhanced retry, shadow re-run");
  assert.match(accounting, /if \(!externalProcessing\.allowed\) return;/, "shadow mode never runs for a blocked workspace");
  assert.match(read("app/api/accounting/ai/route.ts"), /getExternalProcessing\(context\.supabase, context\.workspaceId\)\)\.allowed/);
  assert.match(read("lib/accounting/ai-service.ts"), /if \(!openaiKey \|\| !allowExternalProviders\) return deterministicCommentary/);
});

test("a blocked workspace's providers are first-party only", () => {
  const adapters = read("lib/workflow-adapters.ts");
  assert.match(adapters, /allowExternal \? new OpenAIVisionOcrProvider\(enhanced, true\) : new PipelineOcrProvider\(false, enhanced, false\)/);
  assert.match(adapters, /allowExternal \? new OpenAIExtractionProvider\(true\) : new PipelineExtractionProvider\(false, false\)/);
  assert.match(read("lib/ocr/extractDocument.ts"), /const useOpenAI = options\.useOpenAI && options\.allowExternalProviders;/);
});

test("only the workspace owner can change the setting, and only to a known value", () => {
  const route = read("app/api/workspace-privacy/route.ts");
  const put = route.slice(route.indexOf("export async function PUT"));
  const validate = put.indexOf('value !== "allowed" && value !== "blocked"');
  const owner = put.indexOf("if (!(await isWorkspaceOwner(context)))");
  const write = put.indexOf('.from("workspace_privacy_settings").upsert(');
  assert.ok(validate > 0 && owner > validate && write > owner, "validated, then owner-checked, then written");
  assert.match(put, /status: 403/);
  assert.match(put, /recordAuditLog\(\{\s+action: "external_ai_processing_changed"/, "changes are audit-logged");
  assert.match(route, /canChange: await isWorkspaceOwner\(context\)/);
});
