# DocuCoreX Accounting Worker

FastAPI worker for Accounting Intelligence Phase 1.

It currently supports FNB South Africa business bank statement PDFs. The worker uses deterministic extraction first:

1. Download PDF from the private Supabase `documents` bucket.
2. Extract text with `pdfplumber`.
3. Fall back to PyMuPDF when text is sparse.
4. Parse statement metadata and transactions with deterministic rules.
5. Apply accounting classification rules.
6. Save transactions to Supabase.
7. Generate and upload the Excel workbook.

## Environment

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=documents`

Optional:

- `ACCOUNTING_WORKER_TOKEN` for bearer-token protection between Next.js and the worker.
- `OPENAI_API_KEY` for future ambiguous-description classification. Phase 1 does not require AI.

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
