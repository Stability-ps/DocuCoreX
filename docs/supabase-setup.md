# DocuCoreX Supabase Setup

Run migrations in order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_app_state_tables.sql`

Required tables:

`documents`, `document_versions`, `processing_jobs`, `extraction_results`, `uploads`, `document_shares`, `notifications`, `team_members`, `invites`, `integrations`, `automation_pipelines`, `support_requests`, `user_settings`, `api_keys`, `audit_logs`.

Required Storage bucket:

`documents`

The initial migration creates the private `documents` bucket and workspace-scoped Storage policies. If the bucket is missing in an existing Supabase project, run `supabase/bucket_setup.sql`.

Provider environment variables are optional. Without them, DocuCoreX falls back to internal mock providers for OCR, extraction, and conversion — but only when no Supabase backend is configured. With a real backend and no provider key, requests fail rather than return fabricated output.

- `OPENAI_API_KEY` — vision OCR and structured extraction
- `MISTRAL_API_KEY` — secondary OCR engine (escalation only)
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_KEY` — Azure Document Intelligence in the PDF pipeline

`GOOGLE_VISION_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and `AZURE_FORM_RECOGNIZER_*` are **not** implemented and have no effect — see `docs/PROCESSING_PIPELINE.md` §3.
