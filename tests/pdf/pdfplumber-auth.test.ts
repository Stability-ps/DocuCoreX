import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { extractWithPdfplumber } = await import("@/lib/pdf/extractWithPdfplumber.ts");
const { getExtractionConfig } = await import("@/lib/system-worker-config.ts");

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
const TOKEN = "plumber-test-token-7f3a";

type Recorded = { url: string; headers: Headers };

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Records every fetch and every console line, so a test can assert both what was
// sent and that the token never reached a log.
async function recorded<T>(response: Response, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const calls: Recorded[] = [];
  const logs: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return response;
  }) as typeof fetch;
  console.info = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    return { result: await run(), calls, logs };
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
  }
}

const okBody = () =>
  new Response(JSON.stringify({ pageCount: 1, pages: [{ pageNumber: 1, text: "hello" }], combinedText: "hello" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("sends the bearer token to /extract", async () => {
  const { result, calls } = await withEnv({ PDF_PLUMBER_URL: "https://plumber.test/", PDF_PLUMBER_TOKEN: TOKEN }, () =>
    recorded(okBody(), () => extractWithPdfplumber(PDF_BYTES)),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://plumber.test/extract");
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(result?.combinedText, "hello");
});

test("without the token, the PDF is never uploaded and the gap is named", async () => {
  const { result, calls } = await withEnv({ PDF_PLUMBER_URL: "https://plumber.test", PDF_PLUMBER_TOKEN: undefined }, () =>
    recorded(okBody(), () => extractWithPdfplumber(PDF_BYTES)),
  );
  assert.equal(calls.length, 0, "a runtime without the token must not send the document");
  assert.ok(result, "a configured URL without a token is a failure, not 'not configured'");
  assert.equal(result.pageCount, 0);
  assert.match(result.warnings.join(" "), /PDF_PLUMBER_TOKEN/);
});

test("a whitespace-only token counts as missing", async () => {
  const { calls } = await withEnv({ PDF_PLUMBER_URL: "https://plumber.test", PDF_PLUMBER_TOKEN: "   " }, () =>
    recorded(okBody(), () => extractWithPdfplumber(PDF_BYTES)),
  );
  assert.equal(calls.length, 0);
});

test("without the URL, nothing changes: still null, still no request", async () => {
  const { result, calls } = await withEnv({ PDF_PLUMBER_URL: undefined, PDF_PLUMBER_TOKEN: TOKEN }, () =>
    recorded(okBody(), () => extractWithPdfplumber(PDF_BYTES)),
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("a 401 from the service is a warning, not a crash", async () => {
  const { result } = await withEnv({ PDF_PLUMBER_URL: "https://plumber.test", PDF_PLUMBER_TOKEN: TOKEN }, () =>
    recorded(new Response("{}", { status: 401 }), () => extractWithPdfplumber(PDF_BYTES)),
  );
  assert.equal(result?.pageCount, 0);
  assert.match(result?.warnings.join(" ") ?? "", /HTTP 401/);
});

test("the token never appears in a log line", async () => {
  for (const response of [okBody(), new Response("{}", { status: 401 })]) {
    const { logs } = await withEnv({ PDF_PLUMBER_URL: "https://plumber.test", PDF_PLUMBER_TOKEN: TOKEN }, () =>
      recorded(response, () => extractWithPdfplumber(PDF_BYTES)),
    );
    assert.ok(logs.length > 0, "expected the extractor to log something");
    for (const line of logs) assert.ok(!line.includes(TOKEN), `token leaked into: ${line}`);
  }
});

test("the extraction config reports the URL and the token separately", async () => {
  await withEnv({ PDF_PLUMBER_URL: "https://plumber.test", PDF_PLUMBER_TOKEN: undefined }, async () => {
    assert.deepEqual(getExtractionConfig().pdfPlumber, { configured: false, urlPresent: true, tokenPresent: false });
  });
  await withEnv({ PDF_PLUMBER_URL: "https://plumber.test", PDF_PLUMBER_TOKEN: TOKEN }, async () => {
    const report = getExtractionConfig().pdfPlumber;
    assert.deepEqual(report, { configured: true, urlPresent: true, tokenPresent: true });
    assert.ok(!JSON.stringify(getExtractionConfig()).includes(TOKEN), "the report must carry booleans only");
  });
});
