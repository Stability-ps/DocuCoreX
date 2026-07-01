# DocuCoreX Accounting Worker

FastAPI worker for Accounting Intelligence Phase 1.

It currently supports FNB South Africa business bank statement PDFs. The worker uses deterministic extraction first:

1. Download PDF from the private Supabase `documents` bucket.
2. Extract text with `pdfplumber`.
3. Fall back to PyMuPDF when text is sparse.
4. Parse statement metadata and transactions with deterministic rules.
5. Apply accounting classification rules.
6. Optionally improve ambiguous classifications with OpenAI after parser validation passes.
7. Save transactions to Supabase.
8. Generate and upload the Excel workbook.

## Environment

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=documents`

Optional:

- `ACCOUNTING_WORKER_TOKEN` for bearer-token protection between Next.js and the worker.
- `OPENAI_API_KEY` enables AI classification for ambiguous descriptions after deterministic parsing and reconciliation pass.
- `OPENAI_ACCOUNTING_MODEL` optionally overrides the default `gpt-4o-mini`.

Set `OPENAI_API_KEY` on the Render worker service environment. Adding it only to the Next.js/Vercel app is not enough because the Python worker makes the OpenAI request.

## Render Runtime

This worker pins Python with `.python-version`:

```txt
3.12.8
```

Keep the Render root directory set to:

```txt
workers/accounting_worker
```

If Render still attempts Python 3.14, set this environment variable on the Render service:

```txt
PYTHON_VERSION=3.12.8
```

## Run Locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

Then set the Next.js app variable:

```bash
ACCOUNTING_WORKER_URL=http://127.0.0.1:8001
```
