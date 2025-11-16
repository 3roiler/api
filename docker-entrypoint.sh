#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
node node_modules/node-pg-migrate/bin/node-pg-migrate.js up -m ./migrations

echo "[entrypoint] Starting API server..."
exec node dist/app.js