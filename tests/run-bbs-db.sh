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
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -f /work/tests/bbs-db-setup.sql
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -f /work/bbs-moderation.sql
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -f /work/bbs-moderation.sql
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -f /work/tests/bbs-db.sql
