# DocuCoreX Supabase Setup

Run migrations in order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_app_state_tables.sql`

Required tables:

`documents`, `document_versions`, `processing_jobs`, `extraction_results`, `uploads`, `document_shares`, `notifications`, `team_members`, `invites`, `integrations`, `automation_pipelines`, `support_requests`, `user_settings`, `api_keys`, `audit_logs`.

Required Storage bucket:

`documents`

The initial migration creates the private `documents` bucket and workspace-scoped Storage policies. If the bucket is missing in an existing Supabase project, run `supabase/bucket_setup.sql`.

Provider environment variables are optional. Without them, DocuCoreX uses internal mock providers for OCR, extraction, and conversion:

- `OPENAI_API_KEY`
- `GOOGLE_VISION_API_KEY` or `GOOGLE_APPLICATION_CREDENTIALS`
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- `AZURE_FORM_RECOGNIZER_ENDPOINT` and `AZURE_FORM_RECOGNIZER_KEY`
