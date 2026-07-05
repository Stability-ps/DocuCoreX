# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # start Next.js dev server on port 3000
pnpm build        # production build
pnpm lint         # TypeScript type-check only (tsc --noEmit, no ESLint)
pnpm test         # Playwright e2e tests (spins up Next.js on port 3100 with auth disabled)
pnpm test:accounting-regression  # Python regression suite for the accounting worker
```

Run a single Playwright test file:
```bash
pnpm exec playwright test tests/e2e/conversion-engine.spec.ts
```

Run the accounting worker locally:
```bash
cd workers/accounting_worker
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

## Architecture

DocuCoreX is a Next.js 15 (App Router) document management platform backed by Supabase. The codebase deploys as three separate services:

1. **Next.js frontend** (Vercel) — `app/`, `components/`, `lib/`
2. **Conversion worker** (Render, Docker) — same Next.js codebase running with `CONVERSION_WORKER_MODE=true`, providing OCR/document-format conversion via `ocrmypdf`, `tesseract`, `ghostscript`, and LibreOffice
3. **Accounting worker** (Render, Python) — `workers/accounting_worker/` FastAPI service for processing FNB South Africa bank statement PDFs

### Mock / no-Supabase mode

When `NEXT_PUBLIC_SUPABASE_URL` is absent, all API routes fall back to in-memory stores:
- `lib/mock-repository.ts` — documents, jobs, OCR/extraction results, invoices, notifications
- `lib/app-state.ts` — team members, integrations, automations, user settings

Setting `NEXT_PUBLIC_REQUIRE_AUTH=false` disables auth entirely (the default for local dev). The Playwright tests run with this flag.

### Supabase clients

- `lib/supabase.ts` — browser client; also exports feature flags (`isSupabaseConfigured`, `isAuthRequired`, `isDemoAllowed`)
- `lib/supabase-server.ts` — cookie-based server client (`createSupabaseServerClient`) and service-role client (`createSupabaseServiceRoleClient`) for API routes
- `middleware.ts` — auth guard; redirects unauthenticated users to `/login?next=<path>`; skips API and static routes

### Document processing pipeline

`/api/jobs/process` is the central job processor. It:
1. Checks `CONVERSION_WORKER_URL` and proxies to the Render conversion worker if set
2. Falls back to local execution (fails on Vercel where system tools aren't available)
3. In worker mode (`CONVERSION_WORKER_MODE=true`), accepts a shared secret via `x-docucorex-worker-secret`

Conversion logic lives in `lib/document-conversion-engine.ts`. Provider selection (mock vs. real OCR/AI) is handled by `lib/workflow-adapters.ts` — real providers activate when their respective API keys are present.

### Accounting intelligence

The Python accounting worker (`workers/accounting_worker/main.py`) processes FNB bank statements:
- Deterministic PDF extraction via `pdfplumber` / PyMuPDF
- Bank-specific parsers registered through `engine/registry.py` / `engine/bootstrap.py`
- Optional OpenAI AI classification for ambiguous transactions (needs `OPENAI_API_KEY` on the Render service, not just Vercel)
- Outputs Excel workbooks uploaded back to Supabase storage

### Database

Migrations are in `supabase/migrations/` (numbered 001–011). Schema covers: documents, processing jobs, OCR/extraction results, accounting runs/transactions, invoices, company profiles, notifications.

`lib/server-documents.ts` exports `getWorkspaceContext()` — the standard way for API routes to obtain an authenticated Supabase client plus `userId` / `workspaceId`.

### Key env vars

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role operations in API routes and workers |
| `NEXT_PUBLIC_REQUIRE_AUTH` | `true` to enforce auth in dev; in production auth is on by default |
| `CONVERSION_WORKER_URL` / `CONVERSION_WORKER_SECRET` | Render conversion worker endpoint + shared secret |
| `CONVERSION_WORKER_MODE` | Set `true` on the Render worker to enable worker-mode auth checks |
| `ACCOUNTING_WORKER_URL` / `ACCOUNTING_WORKER_TOKEN` | Accounting FastAPI worker |
| `OPENAI_API_KEY` | Required on the accounting worker Render service for AI classification |
