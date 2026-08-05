"""Fail-closed bearer authentication for the accounting worker.

FAIL CLOSED: an unconfigured secret rejects every request. This service reads
arbitrary objects out of Supabase storage using the service-role key and writes
back accounting runs, so "no secret" must never mean "open to the internet" —
that is exactly the state it shipped in. Verified live on 2026-08-05: an
unauthenticated POST /process-statement reached request validation (HTTP 422).

Deliberately stdlib-only so it can be unit tested without FastAPI, pdfplumber or
Supabase installed; `main.py` maps the verdict onto an HTTP status.

This intentionally mirrors `services/pdf-plumber/auth.py`. The two cannot share a
module: each is a separate Render service with its own `rootDir`, so neither can
import across the repo. `test_auth_matches_pdf_plumber_contract` in the
regression suite pins the two to the same truth table instead.
"""

from __future__ import annotations

import hmac

# Verdicts. Only "ok" permits the request to proceed.
OK = "ok"
UNCONFIGURED = "unconfigured"  # server-side misconfiguration -> 503
MISSING = "missing"  # no Authorization header at all -> 401
MALFORMED = "malformed"  # present but not a well-formed Bearer credential -> 401
INVALID = "invalid"  # well-formed Bearer, wrong value -> 401


def check_bearer(authorization: str | None, expected: str | None) -> str:
    """Classify an Authorization header against the expected shared secret.

    Returns one of OK / UNCONFIGURED / MISSING / MALFORMED / INVALID.
    """
    # 1. No secret configured on the service -> reject everything.
    if expected is None or not expected.strip():
        return UNCONFIGURED

    # 2. No credential supplied.
    if authorization is None or not authorization.strip():
        return MISSING

    # 3. Must be exactly "Bearer <token>". `split(None, 1)` collapses any run of
    #    whitespace, so "Bearer   tok" is accepted but "Bearer" alone is not.
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2:
        return MALFORMED
    scheme, token = parts[0], parts[1].strip()
    if scheme.lower() != "bearer" or not token:
        return MALFORMED

    # 4. Constant-time comparison so the secret cannot be recovered by timing.
    return OK if hmac.compare_digest(token, expected.strip()) else INVALID


# Verdict -> (HTTP status, client-safe message). The message never reveals
# whether a secret is configured beyond the coarse 503/401 distinction.
STATUS_FOR_VERDICT: dict[str, tuple[int, str]] = {
    UNCONFIGURED: (503, "Accounting worker is not configured for authenticated access."),
    MISSING: (401, "Missing Authorization header."),
    MALFORMED: (401, "Malformed Authorization header. Expected 'Bearer <token>'."),
    INVALID: (401, "Invalid credentials."),
}
