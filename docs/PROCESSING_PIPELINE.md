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
| `/api/jobs/process` | **Vercel**, but **proxied to the Render conversion worker** when `CONVERSION_WORKER_URL` is set | the **worker** runtime (when proxied) |
| Accounting (`/api/accounting/fnb/*`) | **Render accounting worker** (Python) | the **accounting worker** runtime |

**Consequence:** `detectProviderConfig()` reads `process.env` **in whichever runtime
runs**. A key set on the accounting worker or locally is **not** visible to the Vercel
runtime that performs `/api/ocr`, nor to the conversion worker. Each runtime needs its
own copy.

## 3. Environment-variable checklist

### Provider selection — exact names read by `detectProviderConfig()` (`lib/workflow-adapters.ts`)

| Purpose | Exact variable name(s) |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| Google Vision | `GOOGLE_VISION_API_KEY` **or** `GOOGLE_APPLICATION_CREDENTIALS` |
| AWS Textract | `AWS_ACCESS_KEY_ID` **and** `AWS_SECRET_ACCESS_KEY` |
| Azure Form Recognizer | `AZURE_FORM_RECOGNIZER_ENDPOINT` **and** `AZURE_FORM_RECOGNIZER_KEY` |

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
| `CONVERSION_WORKER_URL` | ❌ (named `WORKER_URL`) | ❓ verify | ❓ verify | n/a |
| `CONVERSION_WORKER_SECRET` | prod only | ❓ verify | ❓ verify | ❓ verify (must match Vercel) |
| `CONVERSION_WORKER_MODE` | ❌ | must be unset/false | must be unset/false | **must be `"true"`** |
| `PDF_PLUMBER_URL` | ❌ (named `WORKER_plumber`) | ❓ verify | ❓ verify | ❓ verify |

## 4. Deployment checklist — enable a REAL OCR provider (no mock in production)

Pick **one** of the two routes.

### Option A — OCR on the Vercel runtime (simplest for `/api/ocr` + `/api/extractions`)

1. Set the chosen provider key on **Vercel → Project → Settings → Environment Variables**
   for **Production** and **Preview**:
   - OpenAI: `OPENAI_API_KEY`
2. **Remove/leave unset** the higher-priority providers in that runtime if you want
   OpenAI to be selected: `GOOGLE_VISION_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AZURE_FORM_RECOGNIZER_*` — otherwise
   OCR/extraction select those first.
3. Redeploy so the new env is picked up.
4. Verify: `POST /api/jobs/process` for a real document returns `providers.configured.openai: true`
   and OCR text reflects the real document (not the sample placeholder).

> Note: the current in-process adapters only implement **mock** OCR/extraction. Routing
> to a real OpenAI vision + structured-extraction provider requires the code changes in
> the investigation plan (a real `OpenAIOCRProvider`/`OpenAIExtractionProvider`). Setting
> the key alone makes `configured.openai: true` but does not yet perform real OCR until
> those providers exist.

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

## 5. Still out of scope here

- Implementing the real OpenAI vision + structured-extraction providers (mock still used
  until then; it is now honest — 0 confidence, clearly-labelled sample output).
- Deterministic OCR/extraction validation for balances/VAT beyond the existing accounting
  worker.
These are covered by the separate OCR-architecture investigation & plan.
