#!/bin/sh
set -e
umask 077

if [ -n "${DATABASE_CA:-}" ]; then
    echo "[entrypoint] Decoding DATABASE_CA to .certs/ca.crt"
    printf '%s' "$DATABASE_CA" | base64 -d > .certs/ca.crt
    # TODO: node-pg-migrate liest weder `ca` noch `reject-unauthorized` aus
    # .pgmigraterc.json (nur via CLI-Flag oder pg-`ssl`-Objekt). Damit die
    # CA im TLS-Trust-Store landet, sollte hier ggf.
    #   export NODE_EXTRA_CA_CERTS=/app/.certs/ca.crt
    # gesetzt werden, oder node-pg-migrate mit
    #   --no-reject-unauthorized=false  (Default ist false → unsicher)
    # und Anwendung muss `ssl: { ca: fs.readFileSync(...) }` in pg-Config nutzen.
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
