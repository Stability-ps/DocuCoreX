"""Auth checks for the pdfplumber service.

Run from services/pdf-plumber with the service's own requirements installed:

    python tests/check_auth.py

Plain asserts and an explicit call list, like the accounting worker's regression
suite. Exits non-zero on the first failure.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as plumber  # noqa: E402

# Smallest well-formed PDF pdfplumber will open: one empty page.
MINIMAL_PDF = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n%%EOF\n"
)


class env:
    """Set or clear environment variables for the duration of a block."""

    def __init__(self, **values: str | None) -> None:
        self.values = values
        self.saved: dict[str, str | None] = {}

    def __enter__(self) -> None:
        for key, value in self.values.items():
            self.saved[key] = os.environ.pop(key, None)
            if value is not None:
                os.environ[key] = value

    def __exit__(self, *exc: object) -> None:
        for key, value in self.saved.items():
            os.environ.pop(key, None)
            if value is not None:
                os.environ[key] = value


def post_extract(client: TestClient, authorization: str | None):
    headers = {"Authorization": authorization} if authorization is not None else {}
    return client.post("/extract", files={"file": ("t.pdf", MINIMAL_PDF, "application/pdf")}, headers=headers)


def test_extract_route_depends_on_verify_token() -> None:
    routes = [r for r in plumber.app.routes if getattr(r, "path", None) == "/extract"]
    assert len(routes) == 1, "expected exactly one /extract route"
    calls = [d.call for d in routes[0].dependant.dependencies]
    assert plumber.verify_token in calls, "/extract no longer depends on verify_token"


def test_unconfigured_token_fails_closed() -> None:
    client = TestClient(plumber.app)
    with env(PDF_PLUMBER_TOKEN=None):
        for header in (None, "Bearer anything"):
            response = post_extract(client, header)
            assert response.status_code == 503, f"{header!r} -> {response.status_code}"


def test_wrong_or_missing_credentials_are_rejected() -> None:
    client = TestClient(plumber.app)
    with env(PDF_PLUMBER_TOKEN="correct-horse"):
        for header in (None, "Bearer wrong", "correct-horse", "Basic correct-horse"):
            response = post_extract(client, header)
            assert response.status_code == 401, f"{header!r} -> {response.status_code}"
            assert "correct-horse" not in response.text, "a rejection must not echo the secret"


def test_correct_token_extracts() -> None:
    client = TestClient(plumber.app)
    with env(PDF_PLUMBER_TOKEN="correct-horse"):
        response = post_extract(client, "Bearer correct-horse")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["parser"] == "pdfplumber"
    assert body["pageCount"] == 1


def test_health_stays_open() -> None:
    # Render's health check carries no credential.
    with env(PDF_PLUMBER_TOKEN=None):
        assert TestClient(plumber.app).get("/health").status_code == 200


def test_verify_token_raises_http_exceptions_only() -> None:
    with env(PDF_PLUMBER_TOKEN="correct-horse"):
        plumber.verify_token("Bearer correct-horse")  # must not raise
        # The zero-width space is a non-ASCII credential: an HTTP client will not
        # even encode it, but a server can still receive one. It must be a 401,
        # not the TypeError hmac.compare_digest raises on non-ASCII str.
        for header in ("Bearer nope", "Bearer correct-horse\u200b"):
            try:
                plumber.verify_token(header)
            except HTTPException as exc:
                assert exc.status_code == 401, f"{header!r} -> {exc.status_code}"
            else:
                raise AssertionError(f"{header!r} was accepted")


def test_docs_are_closed_on_deployments() -> None:
    with env(PDF_PLUMBER_DOCS=None, RENDER="true"):
        assert plumber.api_docs_enabled() is False, "docs must be closed on Render"
    with env(PDF_PLUMBER_DOCS="1", RENDER="true"):
        assert plumber.api_docs_enabled() is True, "PDF_PLUMBER_DOCS=1 must reopen them"


if __name__ == "__main__":
    for check in (
        test_extract_route_depends_on_verify_token,
        test_unconfigured_token_fails_closed,
        test_wrong_or_missing_credentials_are_rejected,
        test_correct_token_extracts,
        test_health_stays_open,
        test_verify_token_raises_http_exceptions_only,
        test_docs_are_closed_on_deployments,
    ):
        check()
        print(f"ok  {check.__name__}")
    print("pdfplumber auth: all checks passed")
