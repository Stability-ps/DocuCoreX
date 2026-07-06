"""Standalone pdfplumber extraction service for DocuCoreX.

Returns the normalized extraction shape the Node pipeline expects:

    {
      "parser": "pdfplumber",
      "pageCount": int,
      "pages": [
        {"pageNumber": int, "text": str, "words": [...], "tables": [[...]], "lines": [...]}
      ],
      "combinedText": str,
      "warnings": [str]
    }

Run: uvicorn app:app --reload --port 8001   (set PDF_PLUMBER_URL=http://localhost:8001)
"""

from __future__ import annotations

import io
from typing import Any

import pdfplumber
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse

app = FastAPI(title="DocuCoreX pdfplumber service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "pdf-plumber"}


def _word(word: dict[str, Any]) -> dict[str, Any]:
    return {
        "text": word.get("text", ""),
        "x": word.get("x0"),
        "y": word.get("top"),
        "width": (word.get("x1", 0) - word.get("x0", 0)) if word.get("x1") is not None else None,
        "height": (word.get("bottom", 0) - word.get("top", 0)) if word.get("bottom") is not None else None,
    }


def _line(line: dict[str, Any]) -> dict[str, Any]:
    return {"x0": line.get("x0"), "y0": line.get("top"), "x1": line.get("x1"), "y1": line.get("bottom")}


@app.post("/extract")
async def extract(file: UploadFile = File(...)) -> JSONResponse:
    try:
        raw = await file.read()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read upload: {exc}") from exc

    warnings: list[str] = []
    pages: list[dict[str, Any]] = []
    try:
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            for index, page in enumerate(pdf.pages):
                try:
                    text = page.extract_text() or ""
                except Exception as exc:  # noqa: BLE001 — never fail the whole doc on one page
                    text = ""
                    warnings.append(f"page {index + 1} text: {exc}")
                try:
                    words = [_word(w) for w in (page.extract_words() or [])]
                except Exception:  # noqa: BLE001
                    words = []
                try:
                    tables = [t for t in (page.extract_tables() or []) if t]
                except Exception:  # noqa: BLE001
                    tables = []
                try:
                    lines = [_line(l) for l in (page.lines or [])]
                except Exception:  # noqa: BLE001
                    lines = []
                pages.append({
                    "pageNumber": index + 1,
                    "text": text,
                    "words": words,
                    "tables": tables,
                    "lines": lines,
                })
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"pdfplumber could not open the PDF: {exc}") from exc

    combined_text = "\n".join(p["text"] for p in pages)
    return JSONResponse(
        {
            "parser": "pdfplumber",
            "pageCount": len(pages),
            "pages": pages,
            "combinedText": combined_text,
            "warnings": warnings,
        }
    )
