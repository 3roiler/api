#!/bin/sh
set -e

if [ -n "${DATABASE_CA:-}" ]; then
    echo "[entrypoint] Decoding DATABASE_CA to .certs/ca.crt"
    printf '%s' "$DATABASE_CA" | base64 -d > .certs/ca.crt
fi

echo "[entrypoint] Starting API server..."
exec node dist/app.js