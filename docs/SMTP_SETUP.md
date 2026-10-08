# Production email (SMTP) for Supabase Auth

**Status (2026-10-08): not configured.** Production Auth uses Supabase's
built-in mailer. That mailer only delivers to members of the Supabase
organisation and is rate-limited to a handful of messages an hour. So:

- customers never receive password-reset emails, and
- **email confirmation must stay OFF.** Turning it on would lock out every
  new sign-up, because the confirmation email would never arrive.

Everything below that needs no credentials or DNS access is already in this
repository: the templates in `supabase/templates/`, and the Site URL and
redirect allowlist already set in Auth (`https://www.docucorex.com`,
`https://www.docucorex.com/**`, `http://localhost:3000/**`).

## 1. Choose a provider

Any SMTP relay works. Pick one with a sending domain you control:

| Provider | Notes |
|---|---|
| Resend | simplest setup, SMTP host `smtp.resend.com`, port 465 or 587, username `resend`, password = API key |
| Postmark | strongest deliverability for transactional mail, host `smtp.postmarkapp.com`, port 587 |
| Amazon SES | cheapest at volume, regional host e.g. `email-smtp.eu-west-2.amazonaws.com` (the DB is in eu-west-2), port 587, SMTP credentials generated in the SES console |

Use a dedicated sending address such as `no-reply@docucorex.com`, or a
subdomain such as `mail.docucorex.com` if the root domain's mail is
handled elsewhere.

## 2. DNS (needs access to docucorex.com's DNS)

The provider shows the exact values. The shapes are:

| Type | Name | Value | Purpose |
|---|---|---|---|
| TXT | `docucorex.com` (or the sending subdomain) | `v=spf1 include:<provider SPF host> ~all` | SPF. **Merge** into an existing SPF record; a domain may have only one |
| CNAME/TXT | `<selector>._domainkey` | provider-issued DKIM key(s) | DKIM signing |
| TXT | `_dmarc.docucorex.com` | `v=DMARC1; p=quarantine; rua=mailto:<reports address>` | DMARC. Start at `p=none` if other senders exist on the domain |
| MX / TXT | as the provider requires for a custom MAIL FROM / return path | provider-issued | bounce handling (SES, Postmark) |

Wait until the provider reports the domain **verified** before continuing.

## 3. Supabase Auth settings (Dashboard → Authentication)

**SMTP Settings** → Enable custom SMTP:

| Field | Value |
|---|---|
| Sender email | `no-reply@docucorex.com` |
| Sender name | `DocuCoreX` |
| Host / Port | from step 1 (587 with STARTTLS, or 465) |
| Username / Password | from the provider. Enter them only here, never in the repository or in chat |
| Minimum interval between emails | 60 s (default) |

**Rate Limits** → raise "emails sent per hour" from the built-in default to
your expected volume (e.g. 100).

**Email Templates**: paste in:

| Template | File | Subject |
|---|---|---|
| Reset Password | `supabase/templates/recovery.html` | `Reset your DocuCoreX password` |
| Confirm signup | `supabase/templates/confirmation.html` | `Confirm your DocuCoreX account` |

Both use `{{ .ConfirmationURL }}`, which honours the `redirectTo` the app
sends. Password reset sends the user to `/auth/callback?next=/auth/reset-password`,
and the callback exchanges the code (PKCE). Do not hard-code a URL in the
template.

**Do not** enable "Confirm email" yet.

## 4. Verify before enabling confirmations

1. Request a password reset from `https://www.docucorex.com/login` for an
   address **outside the Supabase organisation** (for example a fresh
   Gmail or Outlook mailbox).
2. The email arrives within a minute, in the inbox (not spam). In the raw
   headers: `spf=pass`, `dkim=pass`, `dmarc=pass`.
3. The link opens `/auth/reset-password`. Setting a new password works: the
   old password returns 401 and the new one 200.
4. Auth logs show no `smtp` errors.

Only after all four pass: **Authentication → Providers → Email → Confirm
email: ON**, then sign up with another outside address and confirm that the
confirmation email arrives and the link signs the user in.

## Rollback

- Bad delivery after enabling SMTP: turn custom SMTP off. Auth falls back to
  the built-in mailer, which is the current state.
- Confirmation enabled and emails not arriving: turn "Confirm email" off
  immediately. Users created in the meantime stay unconfirmed. Confirm them
  from Dashboard → Authentication → Users, or have them use password reset.
