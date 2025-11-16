#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
./node_modules/.bin/node-pg-migrate up -m ./migrations --single-transaction --envPath .env

echo "[entrypoint] Starting API server..."
exec node dist/app.js