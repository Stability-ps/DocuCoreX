#!/usr/bin/env bash
set -euo pipefail

# The suite includes real-PDF regression cases that need pdfplumber. Those cases
# used to `try: import pdfplumber / except: return`, and this runner used the
# SYSTEM python3 — which has no pdfplumber — so they silently returned and the
# suite reported success without ever touching a real statement. That hid a live
# parser defect for the whole of an investigation.
#
# The worker's own virtual environment is therefore preferred, and a missing test
# dependency is now a hard failure rather than a silent skip.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/accounting_worker"
VENV_PYTHON="$WORKER_DIR/.venv/bin/python"

if [ -x "$VENV_PYTHON" ]; then
  PYTHON_BIN="$VENV_PYTHON"
elif command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3.11)"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo "Python 3.10+ is required for the accounting regression suite." >&2
  exit 1
fi

echo "accounting regression: using $PYTHON_BIN"

"$PYTHON_BIN" - <<'PY'
import sys

if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10+ is required for the accounting regression suite.")

# Fail LOUDLY on a missing test dependency. A silently skipped real-PDF case is
# worse than no case at all: it reports success while covering nothing.
missing = []
for module in ("pdfplumber", "fitz", "openpyxl"):
    try:
        __import__(module)
    except Exception:  # noqa: BLE001
        missing.append(module)
if missing:
    raise SystemExit(
        "Accounting regression dependencies missing: "
        + ", ".join(missing)
        + "\nInstall them (cd workers/accounting_worker && python3 -m venv .venv"
        " && . .venv/bin/activate && pip install -r requirements.txt) and re-run."
        " The suite must never skip real-PDF cases silently."
    )
PY

# The worker's request contract. This existed but was wired into nothing, so a
# breaking change to ProcessRequest could reach Render without any suite noticing.
"$PYTHON_BIN" "$WORKER_DIR/tests/request_model_check.py"

# Amount parsing and classification assertions. Also previously wired into
# nothing, and it had rotted: a category defect plus two call sites left behind
# by a signature change, none of which any suite would have reported.
"$PYTHON_BIN" "$WORKER_DIR/tests/amount_parsing_check.py"

# Deterministic ledger repair: balance-sign recovery and non-posting detection.
# Bank-neutral by construction, and one of its checks asserts that — a repair
# that needs an institution name will not travel to the next country.
"$PYTHON_BIN" "$WORKER_DIR/tests/ledger_repair_check.py"

"$PYTHON_BIN" "$WORKER_DIR/tests/regression_suite.py"
