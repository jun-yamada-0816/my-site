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

# The cafe list depends on is_site_admin(), so it must refuse to run before admin-only.sql.
if run -f /work/admin-cafes.sql > /tmp/cafes-first.log 2>&1; then
  echo "expected admin-cafes.sql to require admin-only.sql"; exit 1
fi
grep -q 'admin-only.sql' /tmp/cafes-first.log

# With the placeholder left in place and no admin yet, the file must stop without changing anything.
if run -f /work/admin-only.sql > /tmp/first.log 2>&1; then
  echo "expected admin-only.sql to refuse the placeholder"; exit 1
fi
grep -q 'YOUR_ADMIN_USER_ID_HERE' /tmp/first.log
test "$(run -tAc "select to_regclass('public.site_admins') is null")" = t

# An email address instead of a UID is refused.
sed "s/'YOUR_ADMIN_USER_ID_HERE';/'admin@example.test';/" /work/admin-only.sql > /tmp/email.sql
if run -f /tmp/email.sql > /tmp/email.log 2>&1; then
  echo "expected admin-only.sql to refuse an email address"; exit 1
fi

sed "s/'YOUR_ADMIN_USER_ID_HERE';/'11111111-1111-4111-8111-111111111111';/" /work/admin-only.sql > /tmp/admin.sql
run -f /tmp/admin.sql
# Re-running the untouched file later must also succeed.
run -f /work/admin-only.sql
run -f /work/tests/admin-only-db.sql
run -f /work/admin-cafes.sql
run -f /work/admin-cafes.sql
run -f /work/tests/admin-cafes-db.sql
