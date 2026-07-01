# DocuCoreX Deployment

## Required Environment Variables

Set these in Vercel Project Settings:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_REQUIRE_AUTH`

Optional provider variables:

- `OPENAI_API_KEY`
- `GOOGLE_VISION_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AZURE_FORM_RECOGNIZER_ENDPOINT`
- `AZURE_FORM_RECOGNIZER_KEY`

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

Recommended schedule:

```json
{
  "path": "/api/jobs/process",
  "schedule": "*/5 * * * *"
}
```

This processes queued upload, OCR, extraction, and conversion jobs every five minutes. For high-volume production traffic, move processing to a dedicated queue/worker.

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
