#!/usr/bin/env bash
#
# Rebuild the LOCAL Supabase database from scratch: every migration in order,
# then the synthetic seed (supabase/seed.local.sql). Destroys local data only.
#
# Refuses anything that is not the local stack: it talks to 127.0.0.1:54322 and
# never reads .env files, so it cannot reach a hosted project.
#
# Requires Docker (allow ~8-10 GB of free disk for the Supabase images) and runs
# the Supabase CLI through npx, pinned below.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPABASE_CLI="npx -y supabase@2.121.0"
LOCAL_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

cd "$ROOT"

if ! $SUPABASE_CLI status >/dev/null 2>&1; then
  echo "The local Supabase stack is not running. Start it with: $SUPABASE_CLI start" >&2
  exit 1
fi

echo "==> resetting the local database (migrations 001..latest)"
$SUPABASE_CLI db reset --local

echo "==> seeding synthetic accounts and workspaces"
if command -v psql >/dev/null 2>&1; then
  psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -q -f supabase/seed.local.sql
else
  docker exec -i supabase_db_docucorex-local psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < supabase/seed.local.sql
fi

echo "==> done. Accounts (password: local-dev-only-password):"
echo "    owner-a@docucorex.test  admin-a@docucorex.test  viewer-a@docucorex.test  owner-b@docucorex.test"
