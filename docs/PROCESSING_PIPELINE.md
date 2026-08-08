# Document processing pipeline — fix notes, env checklist & OCR deployment

This document accompanies the upload-processing pipeline fix. It explains the
change, the exact environment variables each runtime needs, and a checklist for
enabling a **real** OCR provider (no mock in production).

> No secret values appear in this document — only variable **names** and
> present/absent status.

## 1. What the fix changes

Previously, the documents upload panel fired a **context-less** `POST /api/jobs/process`
(no body). In production that request is proxied to the Render conversion worker,
which — with no `documentId`/`jobId` and no resolvable cookie session — fell through
to the in-memory demo path and returned `processed: 0, mode: "demo"`. Uploaded
documents therefore stayed `uploaded`/`queued` forever.

The fix:

1. **Targeted triggers.** The upload panel and the live-status poll now call
   `/api/jobs/process` with a concrete `{ documentId }` for each active document.
2. **Worker context resolution.** `getServiceRoleContextForJob()` now resolves a
   `documentId` **directly from the `documents` table** (service role), for **any**
   job type — not only conversions. This is what lets a forwarded (cookie-less)
   worker request process real `upload`/`ocr`/`extraction` jobs.
3. **No silent demo fallback.** `resolveProcessingMode()` (pure, unit-tested) gates
   the demo path behind “Supabase is genuinely not configured”. A real backend that
   cannot resolve a workspace now returns `401 WORKSPACE_CONTEXT_UNRESOLVED` instead
   of a misleading `processed: 0, mode: "demo"`.
4. **Visible failures.** A failed `upload`/`ocr`/`extraction` job now sets the
   document status to `failed` (via `documentStatusOnJobFailure`), and the upload
   panel surfaces a start-of-processing error on the row — no more permanent
   `queued` state.

Happy-path progression is centralised in `documentStatusAfterJob()`:
`upload → queued → (ocr) processing → (extraction) ready`.

## 2. Which runtime does what

| Route | Runtime that executes it | Reads provider env from |
|---|---|---|
| `/api/ocr/:documentId` | **Vercel** (in-process `createWorkflowAdapters()`) | the **Vercel** runtime |
| `/api/extractions/:documentId` | **Vercel** (in-process) | the **Vercel** runtime |
| `/api/pdf/analyze/:documentId` | **Vercel** (in-process `runExtractionPipeline`) | the **Vercel** runtime |
| `/api/jobs/process` | **Vercel**, but **proxied to the Render conversion worker** when `CONVERSION_WORKER_URL` is set | the **worker** runtime (when proxied) |
| Accounting (`/api/accounting/fnb/process`) | **Vercel** runs the Node extraction pipeline; only `/process-statement` is called on the **Render accounting worker** (Python) | **Vercel** for the pipeline, the **accounting worker** for parsing |

**Consequence:** `detectProviderConfig()` reads `process.env` **in whichever runtime
runs**. A key set on the accounting worker or locally is **not** visible to the Vercel
runtime that performs `/api/ocr`, nor to the conversion worker. Each runtime needs its
own copy.

### Where `runExtractionPipeline` (and therefore Mistral OCR) actually executes

`extractWithMistralOcr` is called from inside `runExtractionPipeline`, so it runs
in whichever runtime executes that function — **not** always Vercel:

| # | Entry point | Call chain | Runtime |
|---|---|---|---|
| 1 | Generic document OCR job (`POST /api/jobs/process`) | Vercel `proxyToConversionWorker` forwards to the worker → worker (`CONVERSION_WORKER_MODE=true`) skips the proxy and runs locally → `createWorkflowAdapters()` → `PipelineOcrProvider` → `extractDocument` → `runExtractionPipeline` | **Render conversion worker** |
| 2 | `POST /api/ocr/:documentId` | in-process `createWorkflowAdapters()` → `after()` → `runOcrJob` → `extractDocument` → `runExtractionPipeline` | **Vercel** |
| 3 | `GET /api/pdf/analyze/:documentId` | in-process → `runExtractionPipeline` | **Vercel** |
| 4 | Accounting pre-extraction | `after()` → `processStatementInBackground` → `runPipelineBeforeWorker` → `runExtractionPipeline` | **Vercel** |
| 5 | Accounting Enhanced-OCR retry | same function, second call with `enhancedOcr: true` | **Vercel** |

Paths 2–5 hold no proxy and make no outbound call to the conversion worker other
than `extractWithOcr`'s `/api/ocr-text` request. Path 1 is the exception: the
whole pipeline is executed **on the worker**, because `/api/jobs/process` is the
only route that forwards the job itself rather than just the OCR sub-request.

> ⚠️ **`MISTRAL_API_KEY` must therefore be set on BOTH Vercel and the Render
> conversion worker.** Setting it on Vercel alone silently disables the second
> engine for every generic document OCR/extraction job.

## 3. Environment-variable checklist

### Provider selection — exact names read by `detectProviderConfig()` (`lib/workflow-adapters.ts`)

| Purpose | Exact variable name(s) | Implemented? |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | ✅ vision OCR + structured extraction |
| Tesseract | `CONVERSION_WORKER_URL` (via the worker's `/api/ocr-text`) | ✅ OCR fallback |
| Google Vision | `GOOGLE_VISION_API_KEY` **or** `GOOGLE_APPLICATION_CREDENTIALS` | ❌ no client in this codebase |
| AWS Textract | `AWS_ACCESS_KEY_ID` **and** `AWS_SECRET_ACCESS_KEY` | ❌ no client in this codebase |
| Azure Form Recognizer | `AZURE_FORM_RECOGNIZER_ENDPOINT` **and** `AZURE_FORM_RECOGNIZER_KEY` | ❌ no client in this codebase |
| Mistral OCR (secondary engine) | `MISTRAL_API_KEY` | ✅ escalation only — see §5 |

> ⚠️ The three engines marked ❌ have **no effect**. `createWorkflowAdapters()`
> withholds their credentials from the selector (`selectionFlags()` in
> `lib/providers/reporting.ts`), so setting those keys never changes which engine
> runs. They are reported back in `providers.unimplemented` on
> `POST /api/jobs/process` precisely so the dead configuration is visible.
>
> Not to be confused with **`AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` / `_KEY`**,
> which are live and unrelated: those drive `lib/pdf/extractWithAzureDocumentIntelligence.ts`
> inside the multi-parser PDF pipeline (§5), not provider selection.

> `MISTRAL_API_KEY` is **not** part of provider selection. Mistral is an
> escalation engine inside the extraction pipeline, never a selectable primary
> provider — see §5.

### `MISTRAL_API_KEY` — required in every runtime that runs the pipeline

| Runtime | Required? | Why |
|---|---|---|
| **Vercel** | ✅ **Yes** | Paths 2–5 in §2: `/api/ocr/:id`, `/api/pdf/analyze/:id`, accounting pre-extraction and the Enhanced-OCR retry |
| **Render conversion worker** | ✅ **Yes** | Path 1 in §2: proxied `/api/jobs/process` runs the whole pipeline on the worker |
| **Render accounting worker** (Python) | ❌ No | Never executes the Node pipeline; it only parses text it is given |
| **pdfplumber service** | ❌ No | Text extraction only |

The optional tuning variables (`MISTRAL_OCR_MODEL`, `MISTRAL_OCR_TIMEOUT_MS`,
`MISTRAL_MIN_OCR_CONFIDENCE`, `MISTRAL_MIN_SELECTION_CONFIDENCE`,
`NATIVE_MIN_CONFIDENCE`) follow the same rule: they are read in-process, so set
them in **both** runtimes or the two will behave differently on the same document.

### Conversion worker: its own extractor endpoints

Because path 1 runs the **whole** pipeline on the worker, that runtime needs the
extractors it cannot perform itself.

| Variable | Required on the conversion worker? | Why |
|---|---|---|
| `PDF_PLUMBER_URL` | ✅ **Yes** | pdfplumber is a **separate Python service**; there is no in-process path. Without it `extractWithPdfplumber` returns `null` and the worker loses table-based transaction extraction. |
| `CONVERSION_WORKER_URL` | ❌ **No** | The OCR binaries are already on this service. `extractWithOcr` detects `CONVERSION_WORKER_MODE=true` and calls the engine **in-process**, so no URL is needed and no HTTP request is made. |

**OCR transport by runtime** (`lib/pdf/extractWithOcr.ts`):

| Runtime | Transport | Needs `CONVERSION_WORKER_URL`? |
|---|---|---|
| Vercel | HTTP `POST {CONVERSION_WORKER_URL}/api/ocr-text` | ✅ yes — it is calling a different machine |
| Conversion worker | in-process `runOcrText()` from `lib/pdf/ocrEngine.ts` | ❌ no |

Both transports share one implementation (`lib/pdf/ocrEngine.ts`) and normalise
through the same mapping, so the `ExtractionResult` is equivalent either way —
same flag escalation, same time budgets, same Tesseract TSV confidence, same
failure classification.

> **Why in-process rather than a self-call.** The engine drives `ocrmypdf` through
> `spawnSync`, which **blocks the Node event loop** for up to
> `CONVERSION_OCR_TIMEOUT_MS` (120 s default). Had the worker called its own
> `/api/ocr-text` over HTTP, one request would park while a second froze the
> instance for the whole OCR — during which the Render health check
> (`/api/conversion-worker/health`) could not respond and the instance might be
> restarted mid-OCR. Calling in-process removes the hop and that failure mode
> entirely.

Selection order (first present wins):
- **OCR:** Google Vision → AWS → Azure → **OpenAI** → `mock`
- **Extraction:** Azure → AWS → **OpenAI** → `mock`

> ⚠️ With Google/AWS/Azure keys present, OCR/extraction pick those **before** OpenAI.
> To route through OpenAI you must ensure the earlier providers are **absent** in that
> runtime (or implement an explicit provider override — see the investigation plan).

### Worker / infra names read by the code

| Purpose | Exact variable name |
|---|---|
| Conversion worker endpoint | `CONVERSION_WORKER_URL` |
| Conversion worker shared secret | `CONVERSION_WORKER_SECRET` |
| Conversion worker-mode flag | `CONVERSION_WORKER_MODE` (`"true"` on the worker only) |
| pdfplumber service | `PDF_PLUMBER_URL` |
| Accounting worker | `ACCOUNTING_WORKER_URL`, `ACCOUNTING_WORKER_TOKEN` |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |

### ⚠️ Observed name mismatches in local `.env` files (names only)

The local `.env.local` / `.env.production` define **`WORKER_URL`** and **`WORKER_plumber`**,
but the code reads **`CONVERSION_WORKER_URL`** and **`PDF_PLUMBER_URL`**. If the same
names are used on Vercel, the conversion worker and pdfplumber service are effectively
**not configured**. **Action: rename to the code-expected names** (or update the code —
decided separately).

| Code expects | Present locally under expected name? | Present under a different name? |
|---|---|---|
| `CONVERSION_WORKER_URL` | ❌ no | `WORKER_URL` (rename needed) |
| `PDF_PLUMBER_URL` | ❌ no | `WORKER_plumber` (rename needed) |
| `CONVERSION_WORKER_SECRET` | `.env.production` only (missing in `.env.local`) | — |
| `CONVERSION_WORKER_MODE` | ❌ not in local files | must be `"true"` on the Render worker |

### Per-environment checklist (fill in from each dashboard — do not paste values)

| Variable | Local | Vercel Production | Vercel Preview | Render conversion worker |
|---|---|---|---|---|
| `OPENAI_API_KEY` | present | ❓ verify | ❓ verify | ❓ verify |
| `SUPABASE_SERVICE_ROLE_KEY` | present | ❓ verify | ❓ verify | ❓ verify (needed for worker service-role context) |
| `CONVERSION_WORKER_URL` | ❌ (named `WORKER_URL`) | **required** | **required** | **n/a** — OCR runs in-process in worker mode |
| `CONVERSION_WORKER_SECRET` | prod only | **required** | **required** | **required** (must match Vercel) |
| `CONVERSION_WORKER_MODE` | ❌ | must be unset/false | must be unset/false | **must be `"true"`** |
| `PDF_PLUMBER_URL` | ❌ (named `WORKER_plumber`) | **required** | **required** | **required** (pdfplumber is a separate service) |
| `MISTRAL_API_KEY` | — | **required** | **required** | **required** (path 1 runs the pipeline here) |
| `MISTRAL_OCR_MODEL` | — | optional | optional | optional (pin the same value in both) |

## 4. Deployment checklist — enable a REAL OCR provider (no mock in production)

Pick **one** of the two routes.

### Option A — OCR on the Vercel runtime (simplest for `/api/ocr` + `/api/extractions`)

1. Set the chosen provider key on **Vercel → Project → Settings → Environment Variables**
   for **Production** and **Preview**:
   - OpenAI: `OPENAI_API_KEY`
2. Nothing else needs unsetting. `GOOGLE_VISION_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and `AZURE_FORM_RECOGNIZER_*` are never
   selected (see §3), so leaving them set does not displace OpenAI. Removing them is
   still worthwhile as cleanup — they are dead configuration.
3. Redeploy so the new env is picked up.
4. Verify: `POST /api/jobs/process` for a real document returns `providers.ocr: "openai"`
   and `providers.extraction: "openai"` — the engine that actually ran — and OCR text
   reflects the real document (not the sample placeholder).

> `providers.configured.openai: true` only means the key is present. Use
> `providers.ocr` / `providers.extraction` to confirm what actually ran, and
> `providers.unimplemented` to spot keys that are set but ignored. If selection
> resolves to nothing runnable, both report `"unavailable"` and the request errors
> rather than returning fabricated output.

### Option B — Route OCR through the existing conversion worker

1. On the **Render conversion worker**, set `OPENAI_API_KEY` (and keep
   `CONVERSION_WORKER_MODE="true"`, `SUPABASE_SERVICE_ROLE_KEY`, `CONVERSION_WORKER_SECRET`).
2. On **Vercel**, set `CONVERSION_WORKER_URL` (⚠️ correct name, not `WORKER_URL`) and a
   matching `CONVERSION_WORKER_SECRET`.
3. Change `/api/ocr/:id` and `/api/extractions/:id` to proxy to the worker (currently they
   run in-process on Vercel) — see the investigation plan.
4. Redeploy both. Verify OCR output is real and `mode` is never `"demo"` for authenticated jobs.

### Post-deploy verification (either option)

- Upload a known document → it progresses `uploaded → queued → processing → ready`.
- `/api/ocr/:id` returns text matching the document (not the `[SAMPLE OUTPUT …]` placeholder).
- `/api/jobs/process` never returns `mode: "demo"` for an authenticated request; an
  unresolved workspace returns `401 WORKSPACE_CONTEXT_UNRESOLVED`.
- Clear/reprocess the backlog of previously-stuck documents.

## 5. Analysis-driven extraction & the two OCR engines

**Every document is analysed first**, and the analysis alone selects the strategy.
Native extraction is preferred for genuine digital PDFs because OCR cannot improve
correctly embedded text. Whatever path runs, the result passes through the **same**
validation and comparison gate before it is accepted.

```
ANALYSE (always)  →  STRATEGY  →  EXTRACT  →  ACCEPT  →  ESCALATE (if rejected)
lib/pdf/analyzePdf   extraction   pdfjs +     accept-    Tesseract, then Mistral,
                     Strategy.ts  pdfplumber  Extraction  then re-ACCEPT
                                  (+ OCR)     .ts
```

| Strategy | Chosen when | Behaviour |
|---|---|---|
| `native` | `digital` and analysis confidence ≥ `NATIVE_MIN_CONFIDENCE` (60) | PDF.js + pdfplumber only. **No OCR** unless acceptance fails. |
| `native_then_ocr` | `weak-text`, or `digital` below the confidence floor | Native first, then OCR; both become candidates. |
| `ocr_primary` | `scanned` | OCR carries the document; native still collected. |

### The acceptance gate (`lib/pdf/acceptExtraction.ts`)

A result is **`validated`** only when *all four* checks pass:

1. **extraction** — content was actually recovered
2. **completeness** — opening and closing balance are present
3. **reconciliation** — `validateBankStatement` balances
4. **agreement** — no material conflict between extraction sources

Anything short of that is `review_required` (or `failed` when nothing was
recovered at all). **Engine-reported OCR confidence is deliberately not one of
these checks** — a high Tesseract or Mistral score means the characters were
*legible*, not that the extraction is *correct*, so it can never on its own mark
a result validated.

### Provider ladder

Extraction is a ladder of interchangeable providers. Every rung re-enters the
**same** `acceptExtraction()` gate and stops the moment a result is accepted.

```
ANALYSE → STRATEGY → PDF.js + pdfplumber → ACCEPT ──accepted──▶ STOP
                                              │
                                           rejected
                                              ▼
                              Azure Document Intelligence → ACCEPT ──▶ STOP
                                              │
                                           rejected
                                              ▼
                                     Mistral OCR → ACCEPT ──▶ STOP
                                              │
                                           rejected
                                              ▼
                                      Tesseract → ACCEPT ──▶ Review Required
```

**Why Azure before Mistral.** `prebuilt-layout` returns real table structure —
rows, columns, cells — which is what a bank statement's transactions *are*. The
OCR engines return flat text that has to be re-derived by regex, and the
accounting worker re-parses whatever text it is handed. Giving it structured
output first is the shortest path to a correct reconciliation. Mistral remains
the fallback when Azure is unavailable or does no better.

**Why Tesseract is last.** It is free, so there is no cost reason to gate it,
but it is the weakest at preserving column structure — exactly what statement
parsing depends on. It was previously run first; it is now the final resort.

**Why `acceptExtraction()` stays the single gate.** Every provider — native,
Azure, Mistral, Tesseract — is judged by identical rules: content recovered,
completeness, reconciliation and cross-provider agreement for statements;
content, page-coverage quality and agreement for generic documents. There is no
Azure-specific acceptance path, so adding or removing a provider cannot change
what "validated" means. `expect: "bank_statement" | "document"` is unchanged.

**Cost.** Azure never runs on a document that already passed the gate. The first
condition in `decideAzureExtraction` is `accepted && !enhanced → skip`, so a
clean digital PDF costs nothing beyond PDF.js and pdfplumber.

### Engine roles

| Engine | Role | Where the work happens | Called from |
|---|---|---|---|
| **OCRmyPDF / Tesseract** | **Primary.** Always tried first. | Render conversion worker (`POST /api/ocr-text`) | whichever runtime runs the pipeline |
| **Mistral OCR** (`mistral-ocr-4-0`) | **Secondary / escalation only.** | Mistral API (`POST https://api.mistral.ai/v1/ocr`) | **Vercel *or* the conversion worker** — see the runtime table in §2 |

The outbound Mistral request originates in whichever runtime executes
`runExtractionPipeline`, so `MISTRAL_API_KEY` is needed in **both** Vercel and the
Render conversion worker (§3).

Mistral is called **only** when one of these holds (`lib/pdf/mistralDecision.ts`):

- primary OCR confidence < `MISTRAL_MIN_OCR_CONFIDENCE` (default 70), or it
  recovered < 40 characters;
- important fields are missing (no transactions, or no opening/closing balance);
- reconciliation failed;
- overall selection confidence < `MISTRAL_MIN_SELECTION_CONFIDENCE` (default 60);
- **Enhanced OCR** was explicitly requested (`?enhanced=1`).

When both engines run, `mergeExtractionResults` scores each with the existing
`scoreExtraction` and promotes the higher scorer — **Tesseract keeps ties**, as
the primary. If the two engines disagree materially on transaction count,
opening/closing balance, amount totals or date range, the disagreement is
**recorded and forces review** rather than being resolved silently in favour of
the higher scorer.

### Real OCR confidence

`/api/ocr-text` now runs a `tesseract … tsv` pass and reports the **mean per-word
recognition confidence** (`confidenceSource: "tesseract-tsv"`) plus
`lowConfidenceWordRatio`. The old character-density estimate remains as a clearly
labelled `"heuristic"` fallback. ⚠️ This requires a **conversion-worker redeploy**
to take effect; until then the heuristic value is used.

### What is persisted

- `accounting_statement_runs`: `ocr_engine`, `extraction_strategy`,
  `acceptance_verdict`, `ocr_engine_comparison` (migration `017_ocr_engine.sql`).
- `ocr_results.layout` (already `jsonb`, no migration): `engine`,
  `engineConfidence`, `strategy`.
- `parser_debug`: per-stage diagnostics including `mistral_text_length` and the
  full engine comparison.

### Accounting

`ACCOUNTING_PRE_EXTRACT` is now opt-**out** (`=false` is an emergency bypass):
every statement is analysed. Cost is controlled by the strategy — a digital
statement takes the `native` path and never calls OCR. If the Python worker still
reports no parseable transactions, `ACCOUNTING_OCR_FALLBACK` (default on) re-runs
once with Enhanced OCR and retries the worker with the recovered text.

### Secret handling

`MISTRAL_API_KEY` is read from the environment at call time only. It is never
logged, returned, persisted, or written to source — enforced by tests in
`tests/pdf/mistral-ocr.test.ts`. It must be provisioned **twice** (Vercel and the
Render conversion worker); the two runtimes never share environment.

## 6. Still out of scope here

- Implementing the real OpenAI vision + structured-extraction providers (mock still used
  until then; it is now honest — 0 confidence, clearly-labelled sample output).
- Google Vision / AWS Textract / Azure Form Recognizer remain declared in
  `lib/providers/selection.ts` but unimplemented and hard-disabled.
