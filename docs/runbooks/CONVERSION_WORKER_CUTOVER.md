# Runbook: conversion worker cutover (legacy → paid)

Move production conversion traffic from the legacy worker to the paid one.

| | From (legacy) | To (paid) |
|---|---|---|
| Render name | `DocuCoreX-1` (`srv-d94n1su7r5hc73fbodi0`) | `docucorex-conversion-worker` (`srv-d95nd7navr4c73al5it0`) |
| URL | https://docucorex-1.onrender.com | https://docucorex-conversion-worker.onrender.com |
| Plan | free | paid |

**Secret handling:** refer to secrets only by name. The new worker secret lives at `~/.config/docucorex/conversion-worker-secret` (mode 600). Never print it.

## Preconditions (all must hold)

- [ ] The paid worker has these env vars, checked by name in the dashboard:
  - `CONVERSION_WORKER_MODE=true`
  - `CONVERSION_WORKER_SECRET` set to the **new** value from `~/.config/docucorex/conversion-worker-secret`
  - `OPENAI_API_KEY`
  - `PDF_PLUMBER_URL`, plus `PDF_PLUMBER_TOKEN` once PR #168 is rolled out
  - the Supabase vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- [ ] All 13 verification tests against the paid worker pass.
- [ ] `GET https://docucorex-conversion-worker.onrender.com/api/conversion-worker/health` returns 200.
- [ ] Note the **current Production deployment** in Vercel. It is the rollback target.

## Cutover

1. In Vercel → Project → Settings → Environment Variables (**Production**), update both values together. Both are **Sensitive** type.
   - `CONVERSION_WORKER_URL` = `https://docucorex-conversion-worker.onrender.com`
   - `CONVERSION_WORKER_SECRET` = the new value
2. Trigger **one** Production redeploy.

Env vars are bound to each deployment at build time. The old deployment keeps serving with the old URL and secret pair until the new one is promoted, and the new one starts with the new pair. **There is no window where the URL and secret mismatch.** Do not redeploy between the two edits.

## Verification

- [ ] Upload a synthetic statement: OCR and extraction complete and the document reaches its final status.
- [ ] Paid worker Render logs show `docucorex.conversion_worker.process_called` with the job and document ids.
- [ ] Legacy `DocuCoreX-1` logs show **no** new `process_called` after the promotion.
- [ ] Vercel runtime errors: no new conversion-worker 401s or 5xx.

## Rollback

Vercel → Deployments → the previous Production deployment → **Instant Rollback**. That deployment carries the legacy URL and secret pair, so traffic returns to `DocuCoreX-1` immediately. The legacy worker is **not modified** during cutover and stays running, so rollback needs no Render changes.

## After cutover

- Keep `DocuCoreX-1` running, with no env, plan or deploy changes, for **7 days**.
- After 7 clean days, plan its decommission separately, following the same suspend → monitor → delete → rotate pattern as `LEGACY_ACCOUNTING_SERVICE_DECOMMISSION.md`.
- Until it is decommissioned, `DocuCoreX-1` still holds the old `CONVERSION_WORKER_SECRET` and the Supabase and OpenAI credentials.
