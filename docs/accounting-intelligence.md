# Accounting Intelligence

Phase 1 supports FNB South Africa business bank statement PDFs only.

## Flow

1. User opens `/accounting`.
2. User uploads an FNB business bank statement PDF.
3. The Next.js app stores the original PDF in the private Supabase `documents` bucket.
4. The app creates:
   - `documents` row
   - `uploads` row
   - `document_versions` row
   - `processing_jobs` row
   - `accounting_statement_runs` row
5. User clicks `Process`.
6. Next.js calls the Python FastAPI worker through `ACCOUNTING_WORKER_URL`.
7. Worker extracts text with `pdfplumber`, then falls back to PyMuPDF.
8. Worker parses statement metadata and transactions, classifies rows, saves `accounting_transactions`, generates the Excel workbook and uploads it to Storage.
9. User reviews category, VAT treatment, invoice support and notes.
10. User exports the workbook.

## Required Environment

Next.js app:

- `ACCOUNTING_WORKER_URL`
- `ACCOUNTING_WORKER_TOKEN` optional

Python worker:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET=documents`
- `ACCOUNTING_WORKER_TOKEN` optional
- `OPENAI_API_KEY` optional for future ambiguous-description classification

## Database

Apply `supabase/migrations/003_accounting_intelligence.sql`.

It adds:

- `accounting_statement_runs`
- `accounting_transactions`

Both tables have RLS enabled and are workspace-scoped.
