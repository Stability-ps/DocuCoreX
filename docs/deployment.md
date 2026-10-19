# DocuCoreX Deployment

## Required Environment Variables

Set these in Vercel Project Settings:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_REQUIRE_AUTH`

Optional provider variables:

- `OPENAI_API_KEY` — vision OCR and structured extraction
- `MISTRAL_API_KEY` — secondary OCR engine (escalation inside the extraction pipeline)
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_KEY` —
  Azure Document Intelligence (`prebuilt-layout`) in the multi-parser PDF pipeline

The following are read for reporting but **have no effect** — no client for these
engines exists in the codebase, and provider selection never picks them:

- `GOOGLE_VISION_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- `AZURE_FORM_RECOGNIZER_ENDPOINT` / `AZURE_FORM_RECOGNIZER_KEY` (distinct from the
  `AZURE_DOCUMENT_INTELLIGENCE_*` pair above, which is live)

If set, they are listed in `providers.unimplemented` on `POST /api/jobs/process`.
See `docs/PROCESSING_PIPELINE.md` §3.

For Accounting Intelligence, also set `OPENAI_API_KEY` on the Render `docucorex-accounting-worker` service. Vercel environment variables are not automatically available to the FastAPI worker.

## Supabase

Run migrations in order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_app_state_tables.sql`

Confirm the private Storage bucket exists:

- Bucket name: `documents`

The initial migration creates the bucket and workspace-scoped Storage policies. If the bucket is missing, run `supabase/bucket_setup.sql`.

## Vercel Project Settings

For `acapolite/docucorex`, the project must be configured as:

- Framework Preset: `Next.js`
- Root Directory: `.`
- Build Command: `pnpm build`
- Install Command: `pnpm install`
- Output Directory: `.next`

The repository includes `vercel.json` to pin build, install, output, and cron settings. Do not add custom `routes` for this Next.js app unless there is a specific routing requirement.

## Vercel Cron

`vercel.json` schedules `GET /api/jobs/process` daily at 02:00 UTC. It is a
backstop: documents are normally processed while the documents page polls, so
one whose uploader closed the tab would otherwise wait until someone returned.

The sweep (`lib/jobs/cron-sweep.ts`) finds documents with queued or running
generic jobs and hands each to the conversion worker, one at a time, within a
240 s budget (at most 25 documents per run). The worker decides which jobs are
claimable, exactly as for a browser-triggered request.

Required on **Vercel** (Production):

| Variable | Why |
|---|---|
| `CRON_SECRET` | Vercel sends it as `Authorization: Bearer …` on cron requests. Without it the endpoint answers 503 (fails closed); with a wrong value, 401. |
| `CONVERSION_WORKER_URL`, `CONVERSION_WORKER_SECRET` | The sweep calls the worker exactly as the browser-triggered path does. |
| `SUPABASE_SERVICE_ROLE_KEY` | To find documents with pending jobs across workspaces (ids only). |

Before 2026-10-19 the cron called the processor with no session, which a real
backend answers 401: it never processed anything. A daily schedule is what the
current plan allows; a shorter interval (e.g. every 15 minutes) needs a plan
that supports it.

## Deployment Commands

```bash
pnpm install
pnpm lint
pnpm build
vercel --prod
```

## Production Checks

After deployment:

1. Open the direct Vercel deployment URL.
2. Open `/login`.
3. Open `/api/jobs/process`; unauthenticated production access should be reviewed before public launch.
4. Sign in and upload a PDF.
5. Confirm Storage and database rows in Supabase.
6. Confirm `/documents/[id]`, search, conversion, and download work.
