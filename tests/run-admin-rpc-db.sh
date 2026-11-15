#!/bin/sh
# Inside a disposable postgres:16 container, with this repository mounted read-only at /work.
set -eu
docker-entrypoint.sh postgres > /tmp/postgres.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
attempt=0
until pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then cat /tmp/postgres.log; exit 1; fi
  sleep 1
done
run() { psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -f /work/tests/admin-only-db-setup.sql

# admin-rpc.sql depends on is_site_admin(), so it must refuse to run before admin-only.sql.
if run -f /work/admin-rpc.sql > /tmp/rpc-first.log 2>&1; then
  echo "expected admin-rpc.sql to require admin-only.sql"; exit 1
fi
grep -q 'admin-only.sql' /tmp/rpc-first.log

sed "s/'YOUR_ADMIN_USER_ID_HERE';/'11111111-1111-4111-8111-111111111111';/" /work/admin-only.sql > /tmp/admin.sql
run -f /tmp/admin.sql
run -f /work/tests/admin-rpc-db-setup.sql
# Before: a signed-in stranger can run the sync. This is the hole the file closes.
run -c "set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222'; set role authenticated; select * from public.sync_youtube();" > /dev/null

# Applied twice: re-running the SQL in the editor must not wrap the functions twice.
run -f /work/admin-rpc.sql > /tmp/rpc-1.log
run -f /work/admin-rpc.sql > /tmp/rpc-2.log
run -f /work/tests/admin-rpc-db.sql
# The same checks as an API request sees them: connected as authenticator, like PostgREST.
psql -h 127.0.0.1 -U authenticator -d postgres -v ON_ERROR_STOP=1 -q -f /work/tests/admin-rpc-api-db.sql
echo "PASS: admin-rpc.sql"
