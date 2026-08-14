#!/usr/bin/env bash
#
# Stage 4B ledger verification: execute every migration against a real
# PostgreSQL instance and exercise the accounting controls as behaviour.
#
# Static review of SQL did not find the four defects migration 037 fixes. Two of
# them — the concurrent double-post and the undeletable source transaction —
# only appear when the statements actually run, and one of those needs two
# connections at once. So this runs, rather than reads.
#
# It is self-contained and destructive only to its own scratch directory. It
# never reads .env and never connects to a configured database.
#
# Requires: postgresql@16 (brew install postgresql@16).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
PORT="${LEDGER_VERIFY_PORT:-55432}"
PGDATA="${LEDGER_VERIFY_DATA:-${TMPDIR:-/tmp}/docucorex-ledger-verify}"
DB=docucorex_verify
SOCK=/tmp

if [ ! -x "$PGBIN/initdb" ]; then
  echo "PostgreSQL 16 not found at $PGBIN" >&2
  echo "Install it with:  brew install postgresql@16" >&2
  echo "Or set PGBIN to the bin directory of a PostgreSQL 16 install." >&2
  exit 1
fi
export PATH="$PGBIN:$PATH"

cleanup() {
  pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> starting a disposable PostgreSQL on port $PORT"
rm -rf "$PGDATA"
initdb -D "$PGDATA" -U postgres --locale=C -E UTF8 >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PORT -k $SOCK" -l "$PGDATA/server.log" start >/dev/null
sleep 2

psql() { command psql -h "$SOCK" -p "$PORT" -U postgres -X "$@"; }

psql -q -c "create database $DB;" >/dev/null

echo "==> installing the Supabase shim (auth, roles, storage)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/00_supabase_shim.sql" >/dev/null

echo "==> applying all migrations"
failed=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  if ! out=$(psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" 2>&1 >/dev/null); then :; fi
  if echo "$out" | grep -q ERROR; then
    failed=1
    echo "    FAILED $(basename "$f")"
    echo "$out" | grep ERROR | head -3
  fi
done
[ "$failed" -eq 0 ] || { echo "migrations did not apply cleanly"; exit 1; }
echo "    $(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations applied, 0 errors"

echo "==> loading the accounting fixture"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/tests/sql/10_fixture.sql" >/dev/null
psql -q -d "$DB" -f "$ROOT/tests/sql/20_helpers.sql" >/dev/null
psql -q -d "$DB" -c "grant usage on schema public to service_role; grant all on all tables in schema public to service_role;" >/dev/null

echo "==> running the ledger battery"
results=$(mktemp)
for f in 21_core 22_guards 23_integrity 24_remaining 26_gate 27_reporting 28_reconciliation 29_vat 30_period_close 31_fixed_assets 32_receivables_payables 33_coa_import 34_journal_import; do
  psql -d "$DB" -f "$ROOT/tests/sql/$f.sql" 2>&1 \
    | sed -E 's/^psql:[^ ]+ //; s/^NOTICE:  //' | grep -E "^(PASS|FAIL)" || true
done > "$results"
cat "$results"

echo
echo "==> §8 append-only under a BYPASSRLS service role"
for op in "update accounting_postings set debit = 999999.99 where debit > 0" \
          "delete from accounting_postings where debit > 0"; do
  if command psql -h "$SOCK" -p "$PORT" -U service_role -X -d "$DB" -q -c "$op" >/dev/null 2>&1; then
    echo "FAIL  service role performed: $op"
    echo "FAIL" >> "$results"
  else
    echo "PASS  service role refused: ${op%% *} ${op#* }" | cut -c1-90
  fi
done

echo
echo "==> §17 concurrent posting of one journal"
jid=$(psql -t -A -d "$DB" -c "select t_journal('22222222-0000-0000-0000-00000000000a','2026-01-15','44444444-0000-0000-0000-000000001100',1000000.00,'44444444-0000-0000-0000-000000002100',1000000.00,'JV-RACE');")
race=$(mktemp); printf 'begin;\nselect pg_sleep(0.4);\nselect public.accounting_post_journal(%s);\ncommit;\n' "'$jid'" > "$race"
psql -q -d "$DB" -f "$race" >/dev/null 2>&1 &
psql -q -d "$DB" -f "$race" >/dev/null 2>&1 &
wait
read -r rows total <<<"$(psql -t -A -F' ' -d "$DB" -c "select count(*), coalesce(sum(debit),0) from accounting_postings where journal_id='$jid';")"
if [ "$rows" = "2" ] && [ "$total" = "1000000.00" ]; then
  echo "PASS  concurrent double-post produced one entry ($rows rows, $total)"
else
  echo "FAIL  concurrent double-post produced $rows rows totalling $total"
  echo "FAIL" >> "$results"
fi

echo
echo "==> §21 trial balance proof"
psql -d "$DB" -c "
select to_char(sum(debit),'FM99999990.00') as total_debits,
       to_char(sum(credit),'FM99999990.00') as total_credits,
       to_char(sum(debit)-sum(credit),'FM99999990.00') as difference,
       case when sum(debit)=sum(credit) then 'BALANCED' else 'OUT OF BALANCE' end as verdict
from accounting_postings where company_id='22222222-0000-0000-0000-00000000000a';"

fails=$(grep -c '^FAIL' "$results" || true)
passes=$(grep -c '^PASS' "$results" || true)
echo
echo "==> $passes passed, $fails failed"
[ "$fails" -eq 0 ] || exit 1
