# Runbook: enable the nightly job sweep (CRON_SECRET)

Vercel calls `GET /api/jobs/process` daily at 02:00 UTC (`vercel.json`). Production has no `CRON_SECRET`, so every night the route answers **503 `CRON_SECRET_NOT_CONFIGURED`** and processes nothing. That is the safe failure mode. This runbook turns the sweep on.

**Secret handling:** refer to the secret only by name. Keep its single local copy at `~/.config/docucorex/cron-secret` (mode 600, folder 700, outside Git). Never paste it into chat, tickets, PRs or logs.

## Preconditions

1. **Finish the conversion-worker cutover first** ([CONVERSION_WORKER_CUTOVER.md](CONVERSION_WORKER_CUTOVER.md)). The sweep dispatches jobs to `CONVERSION_WORKER_URL`. Turning it on before the cutover would send production work to the legacy free-plan worker.
2. Owner approval for the production environment change.

## Behaviour

| Request | Result |
|---|---|
| No `CRON_SECRET` in the environment | 503 (fails closed) |
| Missing or wrong `Authorization: Bearer …` | 401 |
| Correct bearer with `?dryRun=1` | 200, lists up to 25 candidate document ids, dispatches nothing |
| Correct bearer (what Vercel cron sends) | Dispatches up to 25 documents within a 240 s budget |

## Steps

1. Generate the secret locally (only at this point, never earlier):
   `umask 077; mkdir -p ~/.config/docucorex; openssl rand -hex 32 | tr -d '\n' > ~/.config/docucorex/cron-secret`
2. Vercel → project `docu-core-x` → Settings → Environment Variables → add `CRON_SECRET`, type **Sensitive**, environment **Production** only. Paste it from the file with `pbcopy < ~/.config/docucorex/cron-secret`.
3. Redeploy production. Environment changes apply only to new deployments.
4. Verify without processing anything:
   - Anonymous: `curl -s -o /dev/null -w '%{http_code}' https://www.docucorex.com/api/jobs/process` returns **401**.
   - Dry run: `curl -s -H "Authorization: Bearer $(cat ~/.config/docucorex/cron-secret)" 'https://www.docucorex.com/api/jobs/process?dryRun=1'` returns 200 with `"dryRun":true` and the candidate count. Check the candidates against the queued jobs before letting the 02:00 run happen.
5. Next morning, check the Vercel cron log and the runtime logs for `/api/jobs/process`: a 200 with dispatched, succeeded and failed counts, and no 503.

## Rollback

Delete `CRON_SECRET` from Production and redeploy. The route goes back to 503 and processes nothing. No data changes.
