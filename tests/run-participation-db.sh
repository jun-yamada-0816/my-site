#!/bin/sh
# Inside a disposable postgres:16 container, with this repository mounted read-only at /work:
#   docker run --rm --network none -e POSTGRES_HOST_AUTH_METHOD=trust \
#     -v "$PWD":/work:ro postgres:16 sh /work/tests/run-participation-db.sh
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
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -f /work/tests/participation-db-setup.sql
# Applied twice: re-running the SQL in the editor must keep the records.
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -f /work/participation.sql
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -f /work/participation.sql
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -f /work/tests/participation-db.sql
