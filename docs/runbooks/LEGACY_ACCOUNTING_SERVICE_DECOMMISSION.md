# Runbook: decommission the legacy accounting service "DocuCoreX"

**Secret handling:** refer to secrets only by name. Local copies live at `~/.config/docucorex/<name>` (mode 600). Never print their values.

## Target

| | Legacy (to remove) | Live (keep) |
|---|---|---|
| Render name | `DocuCoreX` | `docucorex-accounting-worker` |
| Service ID | `srv-d92hpm0k1i2s73eu64h0` | `srv-d9pjg7lbedkc73c83mgg` |
| URL | https://docucorex.onrender.com | see the dashboard |
| Root dir | `workers/accounting_worker` | `workers/accounting_worker` |
| Plan | free; auto-deploys `main` | as in `render.yaml` |

Known facts as of 2026-10-20:
- The legacy service is **not referenced** anywhere in the repo or in `render.yaml`.
- Vercel `ACCOUNTING_WORKER_URL` points to the live worker.
- The legacy service has `ACCOUNTING_WORKER_TOKEN` set: an unauthenticated POST returns 401, not 503.
- Its logs only go back to 2026-10-19 and show no successful POSTs. Anything earlier is **unknown**.

Because it has the token, `OPENAI_API_KEY` and probably the Supabase service-role key, it is an extra copy of production credentials on a public hostname.

## 1. Pre-checks

- [ ] In the Render dashboard, open the legacy service → Environment and **record the env var names only**. They tell you which credentials need rotating (step 7).
- [ ] Confirm by **behaviour**, not just by reading the value, that Vercel's `ACCOUNTING_WORKER_URL` targets the live worker. Run one accounting job through the app, then check that `/process-fnb-statement` or `/process-statement` appears in the **live** worker's logs and not in the legacy service's logs.
- [ ] Search the repo once more for the legacy hostname:
  ```sh
  git grep -n "docucorex.onrender.com\|srv-d92hpm0k1i2s73eu64h0"
  ```
  Expect no hits. `docucorex-1.onrender.com` is a different service.

## 2. Disable auto-deploy

Settings → Build & Deploy → Auto-Deploy: **Off**. This stops `main` merges from redeploying the service.

## 3. Suspend

Dashboard → Suspend service. **Verify:** https://docucorex.onrender.com/health no longer returns 200.

## 4. Monitor for 48 hours

Watch:
- **Live worker `GET /health`:** 200.
- **Vercel `/api/accounting/fnb/process`:** requests succeed in the Vercel runtime logs, with no new errors under runtime errors.
- **Render events/logs:** the live worker keeps receiving `/process-*` calls; the legacy service shows no deploys and no resume.
- **Users:** no reports of accounting jobs failing.

## 5. Rollback

If anything depended on it: Dashboard → **Resume service**. Its config and env vars are unchanged. **Verify:** `/health` returns 200 again, then find and fix the caller before you try again.

## 6. Delete

After a clean 48 hours: Settings → **Delete service**. **Verify:** the service is gone from the dashboard and the hostname no longer resolves to a running service.

## 7. Rotate credentials

The legacy service held copies of these credentials, so rotate them, **one at a time and in this order**. For each one: store the new value at `~/.config/docucorex/<name>` (mode 600), update every consumer, redeploy, and verify before moving on.

1. **`ACCOUNTING_WORKER_TOKEN`**: update the live accounting worker and Vercel (Production) **together**, then redeploy Vercel. A mismatch between the two produces 401s on accounting jobs.
   - **Verify:** an unauthenticated POST to the live worker returns 401, and an accounting job through the app succeeds.
2. **`OPENAI_API_KEY`**: create a new key in OpenAI and set it on every consumer that has it: Vercel, the live accounting worker, and the conversion worker(s). *Unverified:* the exact consumer list, so check each service's env names. Revoke the old key only after all consumers are redeployed.
   - **Verify:** an accounting job and an AI-assisted extraction both succeed. Afterwards, the old key shows no usage in OpenAI.
3. **Supabase service-role key**, last. It has the largest blast radius. Its consumers are Vercel, both conversion workers (`DocuCoreX-1`, `docucorex-conversion-worker`) and the live accounting worker.
   - Rotating the legacy JWT secret also invalidates the anon key and every user session. Prefer migrating to Supabase's **new API keys** (`sb_secret_…` / `sb_publishable_…`) and **JWT signing keys**. These let you issue a new secret key, move consumers over, and then revoke the old one with no global logout.
   - **Verify:** upload, conversion and accounting each complete once. In Supabase logs, no requests are still authenticating with the old key before you revoke it.
