#!/bin/sh
# Inside a disposable postgres:16 container, with this repository mounted read-only at /work:
#   docker run --rm --network none --tmpfs /var/lib/postgresql/data \
#     --mount "type=bind,source=$PWD,target=/work,readonly" \
#     -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 sh /work/tests/run-bottle-usage-db.sh
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
run() { psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -f "$1"; }
run /work/tests/participation-db-setup.sql
run /work/tests/bottle-usage-db-setup.sql
# Before participation.sql: it must stop with a message that says what to run first, and change nothing.
if run /work/bottle-usage.sql 2> /tmp/too-early.log; then
  echo 'bottle-usage.sql ran without participation.sql'; exit 1
fi
grep -q 'participation.sql' /tmp/too-early.log || { cat /tmp/too-early.log; exit 1; }
tables=$(psql -h 127.0.0.1 -U postgres -Atc "select count(*) from pg_tables where tablename in ('sea_bottles', 'diary_views')")
[ "$tables" = 0 ] || { echo 'a failed run left tables behind'; exit 1; }
run /work/participation.sql
# Applied twice: re-running the SQL in the editor must keep the records.
run /work/bottle-usage.sql
run /work/bottle-usage.sql
run /work/tests/bottle-usage-db.sql
