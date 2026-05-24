#!/bin/sh
set -e
umask 077

if [ -n "${DATABASE_CA:-}" ]; then
    echo "[entrypoint] Decoding DATABASE_CA to .certs/ca.crt"
    printf '%s' "$DATABASE_CA" | base64 -d > .certs/ca.crt
    # node-pg-migrate liest weder `ca` noch `reject-unauthorized` aus
    # .pgmigraterc.json. Damit die CA bei reject-unauthorized=true im TLS-
    # Trust-Store landet, exportieren wir sie via NODE_EXTRA_CA_CERTS — Node
    # merged sie dann mit dem System-CA-Bundle für jeden TLS-Handshake.
    export NODE_EXTRA_CA_CERTS="$(pwd)/.certs/ca.crt"
fi

# Run pending migrations before the app starts. node-pg-migrate reads
# DATABASE_URL from the environment and uses a pg_advisory_lock-backed
# tracker table, so it's safe under multiple replicas starting at once.
# If migrations fail the container exits non-zero and DO restarts it —
# better than serving a half-schema'd API.
echo "[entrypoint] Running database migrations..."
./node_modules/.bin/node-pg-migrate up -m migrations

echo "[entrypoint] Starting API server..."
exec node dist/app.js
