# Runbook: pdfplumber bearer-token rollout (PR #168)

PR #168 makes `docucorex-pdf-plumber` reject `POST /extract` unless the request carries `Authorization: Bearer $PDF_PLUMBER_TOKEN`. Use this sequence to roll it out with no downtime.

**Secret handling:** refer to the token only by name. Its single local copy lives at `~/.config/docucorex/pdf-plumber-token` (mode 600). Never paste it into chat, tickets, PRs or logs.

## Behaviour after merge

| Request | Result |
|---|---|
| Service has no `PDF_PLUMBER_TOKEN` | `/extract` returns **503** for every request (fails closed) |
| Missing, malformed or wrong bearer | **401** |
| `GET /health` | **200**, no auth |
| `/docs`, `/redoc`, `/openapi.json` on Render | **404**, closed whenever a platform marker such as `RENDER` is set. `PDF_PLUMBER_DOCS` overrides this. |
| Caller with URL but no token | Skips pdfplumber with the warning `PDF_PLUMBER_TOKEN is not configured` and never uploads the PDF |

## Why this order

Render auto-deploys `docucorex-pdf-plumber` from `main`, so **merging is the moment enforcement goes live**. The code on `main` before #168 ignores both the env var and the header. That makes every pre-merge step harmless.

## Sequence

1. **Generate the token.**
   ```sh
   mkdir -p ~/.config/docucorex && umask 077
   openssl rand -hex 32 > ~/.config/docucorex/pdf-plumber-token
   chmod 600 ~/.config/docucorex/pdf-plumber-token
   ```
2. **Set `PDF_PLUMBER_TOKEN` on every caller**, using the same value everywhere:
   - Render `DocuCoreX-1` (`srv-d94n1su7r5hc73fbodi0`): the legacy conversion worker, which **currently serves production**. Verified 2026-10-20 (dashboard, names only): it has **no** `PDF_PLUMBER_URL`, so production does not call pdfplumber today. Add `PDF_PLUMBER_URL` with the token, or do the conversion worker cutover first.
   - Render `docucorex-conversion-worker` (`srv-d95nd7navr4c73al5it0`): it has `PDF_PLUMBER_URL`.
   - Vercel **Production**. Env vars are bound per deployment, so **redeploy Production** afterwards. Add Preview only if previews should call pdfplumber.
3. **Set `PDF_PLUMBER_TOKEN` on `docucorex-pdf-plumber`** and let it redeploy. It still runs the old code, which ignores the token.
4. **Merge PR #168.**
5. **Verify.** Use the service URL from the dashboard; `render.yaml` names it `docucorex-pdf-plumber.onrender.com`.
   ```sh
   U=https://docucorex-pdf-plumber.onrender.com
   curl -s -o /dev/null -w '%{http_code}\n' $U/health                    # 200
   curl -s -o /dev/null -w '%{http_code}\n' -X POST $U/extract           # 401 (503 = service has no token)
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Authorization: Bearer wrong' $U/extract   # 401
   curl -s -o /dev/null -w '%{http_code}\n' $U/openapi.json              # 404
   ```
   - Signed in to the app, `GET /api/system/worker-config` should show `extraction.pdfPlumber` = `{configured: true, urlPresent: true, tokenPresent: true}`. This reflects the **Vercel** runtime only; the workers are checked by the next bullet.
   - Upload a synthetic statement. Its `parser_debug` should show pdfplumber tables, and no `pdfplumber skipped` or `HTTP 401/503` warning.

## Deploy race

After the merge, the service and its callers finish redeploying at different times:
- **Caller on old code, service already enforcing:** the caller sends no header and gets a 401. It records a failed pdfplumber attempt and extraction carries on through PDF.js and the escalation ladder. You lose pdfplumber tables for a few minutes; this is not an outage.
- **Caller on new code, service on old code:** the header is ignored, so this case is fine.

## Rollback

- **Preferred:** revert the #168 merge commit on `main`. Render and Vercel auto-deploy the revert.
- **Quick mitigation:** none on the service side. Removing the token from the service does **not** reopen it; it returns 503 to everyone. That still counts as graceful degradation, because callers fall back without pdfplumber. To restore pdfplumber, fix the token mismatch or revert.
- A caller missing the token only skips pdfplumber, with the same graceful degradation.
